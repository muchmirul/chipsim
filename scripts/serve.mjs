import { createServer as httpServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";
import { pathToFileURL } from "node:url";

export async function createServer(
  root = resolve(import.meta.dirname, ".."),
  port = Number(process.env.PORT || 8000),
) {
  const mime = {
    ".html": "text/html",
    ".js": "text/javascript",
    ".mjs": "text/javascript",
    ".css": "text/css",
    ".json": "application/json",
    ".pdf": "application/pdf",
    ".svg": "image/svg+xml",
  };
  const server = httpServer(async (req, res) => {
    try {
      if (!["GET", "HEAD"].includes(req.method)) {
        res.writeHead(405);
        res.end();
        return;
      }
      const pathname = decodeURIComponent(
          new URL(req.url, "http://localhost").pathname,
        ),
        file = resolve(
          root,
          "." + (pathname === "/" ? "/index.html" : pathname),
        );
      const relative = file.slice(root.length + 1);
      if (
        !file.startsWith(root + sep) ||
        relative
          .split(sep)
          .some(
            (part) =>
              part === ".git" ||
              part === "node_modules" ||
              part.startsWith(".env"),
          )
      ) {
        res.writeHead(403);
        res.end("Forbidden");
        return;
      }
      if (!(await stat(file)).isFile()) throw new Error("Not a file");
      res.writeHead(200, {
        "Content-Type": mime[extname(file)] || "application/octet-stream",
        "Cache-Control": "no-cache",
        "X-Content-Type-Options": "nosniff",
      });
      res.end(req.method === "HEAD" ? undefined : await readFile(file));
    } catch {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  console.log(`ChipSim: http://127.0.0.1:${server.address().port}`);
  return server;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  await createServer();
