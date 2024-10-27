import {
  Router,
  WebRtcTransport,
  Consumer,
  Producer,
} from "mediasoup/node/lib/types";
import { Socket, DefaultEventsMap } from "socket.io";

interface IProducerTransport {
  transport: WebRtcTransport;
  producers: Producer[];
}

interface IConsumerTransport {
  transport: WebRtcTransport;
  consumers: Consumer[];
}

export interface IPeerData {
  email: string;
  socket: Socket<DefaultEventsMap, DefaultEventsMap, DefaultEventsMap, any>;
  roomName: string;
  serverProducerTransport: IProducerTransport;
  serverConsumerTransport: IConsumerTransport;
}

export interface IRoomData {
  router: Router;
  peerSocketIds: string[];
}
