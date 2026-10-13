import { createServer, type Socket } from "node:net";

export async function smtpFixture(port: number) {
  const messages: { recipients: string[]; text: string }[] = [];
  const sockets = new Set<Socket>();
  const errors: Error[] = [];
  let rejectMail = false;
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", (error) => { errors.push(error); socket.destroy(); });
    socket.setEncoding("utf8");
    socket.write("220 localhost Portlyzer test SMTP\r\n");
    let buffer = "";
    let data: string[] | null = null;
    let recipients: string[] = [];
    socket.on("data", (chunk) => {
      buffer += chunk;
      let index: number;
      while ((index = buffer.indexOf("\r\n")) !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        if (data) {
          if (line !== ".") { data.push(line.replace(/^\.\./, ".")); continue; }
          const raw = data.join("\r\n");
          const split = raw.indexOf("\r\n\r\n");
          const headers = raw.slice(0, split);
          const body = raw.slice(split + 4);
          const text = /Content-Transfer-Encoding: base64/i.test(headers) ? Buffer.from(body, "base64").toString("utf8")
            : body.replace(/=\r\n/g, "").replace(/=([0-9A-F]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
          if (!rejectMail) messages.push({ recipients: [...recipients], text });
          socket.write(rejectMail ? "451 Temporary test failure\r\n" : "250 Queued locally\r\n");
          data = null;
          recipients = [];
        } else if (/^(EHLO|HELO) /i.test(line)) socket.write("250-localhost\r\n250 PIPELINING\r\n");
        else if (/^MAIL FROM:/i.test(line)) { recipients = []; socket.write("250 OK\r\n"); }
        else if (/^RCPT TO:/i.test(line)) {
          recipients.push(line.slice(line.indexOf(":") + 1).trim().replace(/^<|>$/g, ""));
          socket.write("250 OK\r\n");
        } else if (line === "DATA") { data = []; socket.write("354 Send data\r\n"); }
        else if (line === "QUIT") socket.end("221 Bye\r\n");
        else if (line === "RSET" || line === "NOOP") socket.write("250 OK\r\n");
        else socket.write("502 Not implemented\r\n");
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return {
    messages,
    reject(value: boolean) { rejectMail = value; },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      if (errors.length) throw new AggregateError(errors, "SMTP test receiver failed.");
    },
  };
}
