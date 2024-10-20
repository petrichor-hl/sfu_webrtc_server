//index.js
const io = require("socket.io-client");
const mediasoupClient = require("mediasoup-client");

const roomName = window.location.pathname.split("/")[2];

const socket = io("/mediasoup");

socket.on("connection-success", ({ socketId }) => {
  console.log("socketId = " + socketId);
  getLocalStream();
});

let device;
let rtpCapabilities;
let producerTransport;
let consumerTransport;

let othersPeersInRoom = {};

let audioProducer;
let videoProducer;

let params = {
  // mediasoup params
  encodings: [
    {
      rid: "r0",
      maxBitrate: 100000,
      scalabilityMode: "S1T3",
    },
    {
      rid: "r1",
      maxBitrate: 300000,
      scalabilityMode: "S1T3",
    },
    {
      rid: "r2",
      maxBitrate: 900000,
      scalabilityMode: "S1T3",
    },
  ],
  // https://mediasoup.org/documentation/v3/mediasoup-client/api/#ProducerCodecOptions
  codecOptions: {
    videoGoogleStartBitrate: 1000,
  },
};

let audioParams;
let videoParams = { params };

const streamSuccess = (stream) => {
  localVideo.srcObject = stream;

  audioParams = { track: stream.getAudioTracks()[0], ...audioParams };
  videoParams = { track: stream.getVideoTracks()[0], ...videoParams };

  joinRoom();
};

const joinRoom = () => {
  socket.emit("joinRoom", { roomName }, (serverRouterRtpCapabilities) => {
    rtpCapabilities = serverRouterRtpCapabilities;
    createDevice();
  });
};

const getLocalStream = () => {
  navigator.mediaDevices
    .getUserMedia({
      audio: true,
      video: {
        width: {
          min: 640,
          max: 1920,
        },
        height: {
          min: 400,
          max: 1080,
        },
      },
    })
    .then(streamSuccess)
    .catch((error) => {
      console.log(error.message);
    });
};

// A device is an endpoint connecting to a Router on the
// server side to send/recive media
const createDevice = async () => {
  try {
    device = new mediasoupClient.Device();
    await device.load({
      routerRtpCapabilities: rtpCapabilities,
    });
    createReceiveTransport();
    createSendTransport();
  } catch (error) {
    console.log(error);
    if (error.name === "UnsupportedError")
      console.warn("browser not supported");
  }
};

const createSendTransport = () => {
  // see server's socket.on('createWebRtcTransport', sender?, ...)
  // this is a call from Producer, so sender = true
  socket.emit("createWebRtcTransport", { consumer: false }, ({ params }) => {
    // The server sends back params needed
    // to create Send Transport on the client side
    if (params.error) {
      console.log(params.error);
      return;
    }
    producerTransport = device.createSendTransport(params);

    // https://mediasoup.org/documentation/v3/communication-between-client-and-server/#producing-media
    // this event is raised when a first call to transport.produce() is made
    // see connectSendTransport() below
    producerTransport.on(
      "connect",
      async ({ dtlsParameters }, callback, errback) => {
        try {
          // Signal local DTLS parameters to the server side transport
          // see server's socket.on('transport-connect', ...)
          await socket.emit(
            "transport-connect",
            {
              dtlsParameters,
            },
            (isAlreadyMembers) => {
              if (isAlreadyMembers) {
                getProducers();
              }
            }
          );

          // Tell the transport that parameters were transmitted.
          callback();
        } catch (error) {
          errback(error);
        }
      }
    );

    producerTransport.on("produce", async (parameters, callback, errback) => {
      try {
        // tell the server to create a Producer
        // with the following parameters and produce
        // and expect back a server side producer id
        // see server's socket.on('transport-produce', ...)
        await socket.emit(
          "transport-produce",
          {
            kind: parameters.kind,
            rtpParameters: parameters.rtpParameters,
          },
          (newProducerId) => {
            callback({ id: newProducerId });
          }
        );
      } catch (error) {
        errback(error);
      }
    });

    connectSendTransport();
  });
};

const connectSendTransport = async () => {
  // we now call produce() to instruct the producer transport
  // to send media to the Router
  // https://mediasoup.org/documentation/v3/mediasoup-client/api/#transport-produce
  // this action will trigger the 'connect' and 'produce' events above

  audioProducer = await producerTransport.produce(audioParams);
  videoProducer = await producerTransport.produce(videoParams);

  audioProducer.on("trackended", () => {
    console.log("audio track ended");
    // close audio track
  });

  audioProducer.on("transportclose", () => {
    console.log("audio transport ended");
    // close audio track
  });

  videoProducer.on("trackended", () => {
    console.log("video track ended");
    // close video track
  });

  videoProducer.on("transportclose", () => {
    console.log("video transport ended");
    // close video track
  });
};

// server informs the client of a new producer just joined
socket.on("new-producer", ({ socketId, newProducerId }) => {
  // console.log("new-producer-id = " + producerId);
  signalNewPeer(socketId, newProducerId);
});

const getProducers = () => {
  socket.emit("getOthersPeerProducerIdsInRoom", (peersProducerIds) => {
    console.log(`Peers in Room`);
    Object.keys(peersProducerIds).forEach((key) => {
      console.log(`Peer ${key}`);
      peersProducerIds[key].forEach((serverProducerId) =>
        signalNewPeer(key, serverProducerId)
      );
    });
  });
};

socket.on("producer-closed", (peerSocketId) => {
  console.log("producer-closed");
  othersPeersInRoom[peerSocketId].forEach((e) => {
    e.localConsumer.close();
    // remove the video div element
    videoContainer.removeChild(
      document.getElementById(`td-${e.serverProducerId}`)
    );
  });
});

const createReceiveTransport = () => {
  socket.emit("createWebRtcTransport", { consumer: true }, ({ params }) => {
    if (params.error) {
      console.log(params.error);
      return;
    }
    consumerTransport = device.createRecvTransport(params);

    consumerTransport.on(
      "connect",
      async ({ dtlsParameters }, callback, errback) => {
        try {
          await socket.emit("transport-recv-connect", {
            dtlsParameters,
          });
          callback();
        } catch (error) {
          errback(error);
        }
      }
    );
  });
};

const signalNewPeer = async (peerSocketId, serverProducerId) => {
  if (!othersPeersInRoom[peerSocketId]) {
    othersPeersInRoom[peerSocketId] = [];
  }

  await socket.emit(
    "transport-recv-consume",
    {
      rtpCapabilities: device.rtpCapabilities,
      serverProducerId,
    },
    async ({ params }) => {
      if (params.error) {
        console.log("Cannot Consume");
        return;
      }
      const localConsumer = await consumerTransport.consume({
        id: params.id, // remote Consumer Id
        producerId: params.producerId, // === serverProducerId
        kind: params.kind, // // remote Consumer kind ("audio" or "video")
        rtpParameters: params.rtpParameters,
      });

      othersPeersInRoom[peerSocketId].push({
        serverProducerId,
        kind: localConsumer.kind,
        localConsumer: localConsumer,
      });

      const newElem = document.createElement("div");
      newElem.setAttribute("id", `td-${serverProducerId}`);

      if (params.kind == "audio") {
        //append to the audio container
        newElem.innerHTML =
          '<audio id="' + serverProducerId + '" autoplay></audio>';
      } else {
        //append to the video container
        newElem.setAttribute("class", "remoteVideo");
        newElem.innerHTML =
          '<video id="' +
          serverProducerId +
          '" autoplay class="video" ></video>';
      }

      videoContainer.appendChild(newElem);

      // destructure and retrieve the video track from the producer
      const { track } = localConsumer;

      document.getElementById(serverProducerId).srcObject = new MediaStream([
        track,
      ]);

      // the server consumer started with media paused
      // so we need to inform the server to resume
      socket.emit("consumer-resume", {
        serverConsumerId: params.id, // === serverProducerId
      });
    }
  );
};

let isMicOn = true;
let isCameraOn = true;

const toggleMic = () => {
  isMicOn = !isMicOn;
  console.log("toggleMic: " + isMicOn);

  if (isMicOn) {
    audioProducer.resume();
  } else {
    audioProducer.pause();
  }
};

const toggleCamera = () => {
  isCameraOn = !isCameraOn;
  console.log("toggleCamera: " + isCameraOn);

  if (isCameraOn) {
    videoProducer.resume();
  } else {
    videoProducer.pause();
  }
};

btnToggleMic.addEventListener("click", toggleMic);
btnToggleCamera.addEventListener("click", toggleCamera);
