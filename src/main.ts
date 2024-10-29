import express from "express";
import http from "http";
// import https from "https";
// import fs from "fs";
import path from "path";
const __dirname__ = path.resolve();

import { Server } from "socket.io";
import * as mediasoup from "mediasoup";
import { IPeerData, IRoomData } from "./type";
import {
  Worker,
  Consumer,
  Producer,
  Router,
  WebRtcTransport,
} from "mediasoup/node/lib/types";
import { config } from "./config";
import { TransportOptions, ConsumerOptions } from "mediasoup-client/lib/types";

/**
 * Worker
 * |-> Router(s)
 *     |-> Producer Transport(s)
 *         |-> Producer
 *     |-> Consumer Transport(s)
 *         |-> Consumer
 **/

const app = express();
app.get("/", (req, res) => {
  res.send("Hello from mediasoup app!");
});
app.use("/sfu/:room", express.static(path.join(__dirname__, "public")));

// SSL cert for HTTPS access
// const options = {
//   key: fs.readFileSync("./server/ssl/key.pem", "utf-8"),
//   cert: fs.readFileSync("./server/ssl/cert.pem", "utf-8"),
// };
// const httpsServer = https.createServer(options, app);

const httpServer = http.createServer(app);
httpServer.listen(3000, () => {
  console.log("listening on port: " + 3000);
});

const io = new Server(httpServer);
const connections = io.of("/mediasoup");

const peers: Record<string, IPeerData> = {}; // Record<socketId, IPeerData> = {}
const rooms: Record<string, IRoomData> = {}; // Record<roomName, IRoomData>

export const main = async () => {
  const worker = await mediasoup.createWorker(config.workder);

  worker.on("died", (error) => {
    console.error("mediasoup worker has died");
    setTimeout(() => process.exit(1), 2000); // exit in 2 seconds
  });

  connections.on("connection", async (socket) => {
    console.log(`\x1b[44m\x1b[30m==> peer ${socket.id} connected\x1b[0m`);

    socket.on("disconnect", () => handlePeerDisconnect(socket.id));

    socket.on("joinRoom", ({ email, roomName }) => {
      socket.join(roomName);
      console.log(`${email} joined room ${roomName}`);

      peers[socket.id] = {
        email,
        socket,
        roomName,
        serverProducerTransport: {
          transport: null as any,
          producers: [],
        },
        serverConsumerTransport: {
          transport: null as any,
          consumers: [],
        },
      };

      joinRoom(worker, roomName, socket.id);
    });

    socket.on("getRouterRtpCapabilities", async ({ roomName }, callback) => {
      const router = rooms[roomName].router;
      callback(router.rtpCapabilities);
    });

    socket.on(
      "createWebRtcTransport",
      async ({ consumer }: { consumer: boolean }, callback) => {
        // get Room Name from Peer's properties
        const roomName = peers[socket.id].roomName;

        // get Router (Room) object this peer is in based on RoomName
        const router = rooms[roomName].router;
        const webRtcTransport = await createWebRtcTransport(router);

        const params: TransportOptions = {
          id: webRtcTransport.id,
          iceParameters: webRtcTransport.iceParameters,
          iceCandidates: webRtcTransport.iceCandidates,
          dtlsParameters: webRtcTransport.dtlsParameters,
        };

        callback(params);

        // add transport to Peer's properties
        addTransport(socket.id, webRtcTransport, consumer);
      }
    );

    // see client's socket.emit('transport-connect', ...)
    socket.on("transport-connect", ({ dtlsParameters }, callback) => {
      // getProducerTransport(socket.id).connect({ dtlsParameters });
      getProducerTransport(socket.id)?.connect({
        dtlsParameters,
      });
      const peersProducerIds = getOthersPeerProducerIdsInRoom(socket.id);
      callback(peersProducerIds);
    });

    // see client's socket.emit('transport-produce', ...)
    socket.on(
      "transport-produce",
      async ({ kind, rtpParameters }, callback) => {
        // call produce based on the prameters from the client
        const newProducer = await getProducerTransport(socket.id).produce({
          kind,
          rtpParameters,
        });

        addProducer(socket.id, newProducer);
        informConsumers(socket.id, newProducer.id);

        // newProducer.on("transportclose", () => {
        //   // By default:
        //   // when the transport this producer belongs to is closed. The producer itself is also closed
        //   // newProducer.close();
        //   console.log(`${newProducer.kind} producer closed`);
        // });

        // Send back to the client the Producer's id
        callback(newProducer.id);
      }
    );

    // see client's socket.emit('transport-recv-connect', ...)
    socket.on("transport-recv-connect", async ({ dtlsParameters }) => {
      await getConsumerTransport(socket.id).connect({
        dtlsParameters,
      });
    });

    socket.on(
      "transport-recv-consume",
      async ({ rtpCapabilities, serverProducerId }, callback) => {
        const { roomName } = peers[socket.id];
        const router = rooms[roomName].router;
        const consumerTransport = getConsumerTransport(socket.id);

        // check if the router can consume the specified producer
        if (
          router.canConsume({
            producerId: serverProducerId,
            rtpCapabilities,
          })
        ) {
          // transport can now consume and return a consumer
          const newConsumer = await consumerTransport.consume({
            producerId: serverProducerId,
            rtpCapabilities,
            paused: true,
          });

          // newConsumer.on("transportclose", () => {
          //   console.log(`${newConsumer.kind} consumer closed`);
          // });

          addConsumer(socket.id, newConsumer);

          const params: ConsumerOptions = {
            id: newConsumer.id, // remote/server Consumer Id
            producerId: serverProducerId,
            kind: newConsumer.kind,
            rtpParameters: newConsumer.rtpParameters,
          };

          // send the parameters to the client
          callback(params);
        }
      }
    );

    socket.on("consumer-resume", async ({ serverConsumerId }) => {
      await getServerConsumer(socket.id, serverConsumerId).resume();
    });
  });

  const createWebRtcTransport = async (router: Router) => {
    const transport = await router.createWebRtcTransport(
      config.webRtcTransport
    );

    transport.on("dtlsstatechange", (dtlsState) => {
      if (dtlsState === "closed") {
        transport.close();
      }
    });

    transport.on("@close", () => {
      // console.log("transport closed");
    });

    return transport;
  };
};

const joinRoom = async (worker: Worker, roomName: string, socketId: string) => {
  let router;
  let peerSocketIds: string[] = [];
  if (rooms[roomName]) {
    router = rooms[roomName].router;
    peerSocketIds = rooms[roomName].peerSocketIds;
  } else {
    router = await worker.createRouter(config.router);
    peerSocketIds = [];
  }

  rooms[roomName] = {
    router: router,
    peerSocketIds: [...peerSocketIds, socketId],
  };

  return router;
};

const addTransport = (
  socketId: string,
  webRtcTransport: WebRtcTransport,
  isConsumer: boolean
) => {
  if (isConsumer) {
    peers[socketId].serverConsumerTransport.transport = webRtcTransport;
  } else {
    peers[socketId].serverProducerTransport.transport = webRtcTransport;
  }
};

const getProducerTransport = (socketId: string) => {
  return peers[socketId].serverProducerTransport.transport;
};

const getConsumerTransport = (socketId: string) => {
  return peers[socketId].serverConsumerTransport.transport;
};

const addProducer = (socketId: string, serverProducer: Producer) => {
  peers[socketId].serverProducerTransport.producers.push(serverProducer);
};

const addConsumer = (socketId: string, serverConsumer: Consumer) => {
  peers[socketId].serverConsumerTransport.consumers.push(serverConsumer);
};

const informConsumers = (socketId: string, newProducerId: string) => {
  const roomName = peers[socketId].roomName;

  peers[socketId].socket
    .to(roomName)
    .emit("new-producer", { peerEmail: peers[socketId].email, newProducerId });
};

const getOthersPeerProducerIdsInRoom = (socketId: string) => {
  const roomName = peers[socketId].roomName;

  const producerIdsInRoom: Record<string, string[]> = {}; // Record<socketId, [producer0.id, producer1.id]>
  rooms[roomName].peerSocketIds.forEach((peerSocketId) => {
    if (peerSocketId !== socketId) {
      const peerEmail = peers[peerSocketId].email;
      producerIdsInRoom[peerEmail] = peers[
        peerSocketId
      ].serverProducerTransport.producers.map((producer) => producer.id);
    }
  });

  return producerIdsInRoom;
};

const getServerConsumer = (socketId: string, serverConsumerId: string) => {
  return peers[socketId].serverConsumerTransport.consumers.find(
    (consumer) => consumer.id === serverConsumerId
  )!;
};

const handlePeerDisconnect = (socketId: string) => {
  const peer = peers[socketId];
  console.log(`${peer.email} left room ${peer.roomName}`);
  console.log(`\x1b[44m\x1b[30m==> peer ${socketId} disconnected\x1b[0m`);
  /**
   * By Default:
   * Emitted when the transport this consumer belongs to is closed for whatever reason.
   * The producer & consumer itself is also closed.
   *
   * When the associated producer is closed for whatever reason.
   * The consumer itself is also closed.
   **/

  const roomName = peers[socketId].roomName;
  rooms[roomName].peerSocketIds = rooms[roomName].peerSocketIds.filter(
    (peerSocketId) => peerSocketId !== socketId
  );

  if (rooms[roomName].peerSocketIds.length === 0) {
    // Nếu room không còn thành viên
    // Close Router => Xoá
    console.log(`Room ${roomName} không còn thành viên`);
    rooms[roomName].router.close();
    delete rooms[roomName];
  } else {
    // Nếu room còn thành viên
    console.log(
      `Room ${roomName} còn ${rooms[roomName].peerSocketIds.length} thành viên`
    );
    rooms[roomName].peerSocketIds.forEach((peerSocketId) => {
      const socket = peers[peerSocketId].socket;
      socket.emit("producer-closed", peers[socketId].email);
    });
  }

  peers[socketId].serverProducerTransport.transport?.close();
  peers[socketId].serverConsumerTransport.transport?.close();
  delete peers[socketId];
};
