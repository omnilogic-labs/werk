import {
  DAEMON_MAX_FRAME_BYTES,
  DEFAULT_MAX_QUEUED_BYTES,
  DAEMON_MAX_QUEUED_BYTES,
} from "@werk/session/protocol";
import type { Transport } from "@werk/session";
/** Browser adapter with bounded receive buffering and explicit congestion errors. */
export async function openWebSocketTransport(
  url: string,
  timeoutMs = 5000,
): Promise<Transport> {
  const socket = new WebSocket(url);
  socket.binaryType = "arraybuffer";
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error("WebSocket connection timed out"));
    }, timeoutMs);
    socket.onopen = () => {
      clearTimeout(timeout);
      resolve();
    };
    socket.onerror = () => {
      clearTimeout(timeout);
      socket.close();
      reject(new Error("WebSocket connection failed"));
    };
  });
  let ended = false;
  const readable = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        socket.onmessage = (event) => {
          if (ended) return;
          if (!(event.data instanceof ArrayBuffer)) {
            ended = true;
            controller.error(new Error("Expected binary protocol bytes"));
            socket.close();
            return;
          }
          controller.enqueue(new Uint8Array(event.data));
          if ((controller.desiredSize ?? 0) < 0) {
            ended = true;
            controller.error(new Error("Browser receive queue exceeded limit"));
            socket.close();
          }
        };
        socket.onclose = () => {
          if (!ended) {
            ended = true;
            controller.close();
          }
        };
        socket.onerror = () => {
          if (!ended) {
            ended = true;
            controller.error(new Error("WebSocket failed"));
          }
        };
      },
      cancel() {
        ended = true;
        socket.close();
      },
    },
    {
      highWaterMark: DEFAULT_MAX_QUEUED_BYTES,
      size: (chunk) => chunk?.byteLength ?? 0,
    },
  );
  return {
    readable,
    writable: new WritableStream({
      write(bytes) {
        if (socket.readyState !== WebSocket.OPEN)
          throw new Error("WebSocket closed");
        if (socket.bufferedAmount + bytes.byteLength > DAEMON_MAX_QUEUED_BYTES)
          throw new Error("WebSocket send queue exceeded limit");
        socket.send(new Uint8Array(bytes));
      },
      abort() {
        socket.close();
      },
      close() {
        socket.close();
      },
    }),
    close() {
      socket.close();
    },
  };
}
