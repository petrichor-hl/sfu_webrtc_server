import {
  RouterOptions,
  WebRtcTransportOptions,
  WorkerLogLevel,
  WorkerLogTag,
  WorkerSettings,
} from "mediasoup/node/lib/types";

interface ISfuServerConfig {
  workder: WorkerSettings;
  router: RouterOptions;
  webRtcTransport: WebRtcTransportOptions;
}

export const config: ISfuServerConfig = {
  workder: {
    logLevel: "debug" as WorkerLogLevel,
    logTags: ["info", "ice", "dtls", "rtp", "srtp", "rtcp"] as WorkerLogTag[],
  },

  router: {
    mediaCodecs: [
      {
        kind: "audio",
        mimeType: "audio/opus",
        clockRate: 48000,
        channels: 2,
      },
      {
        kind: "video",
        mimeType: "video/VP8",
        clockRate: 90000,
        parameters: {
          "x-google-start-bitrate": 1000,
        },
      },
    ],
  },

  webRtcTransport: {
    listenInfos: [
      {
        protocol: "udp",
        ip: "192.168.1.8",
      },
    ],
  },
};
