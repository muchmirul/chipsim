import { build, context } from "esbuild";
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { createServer } from "./serve.mjs";

const root = resolve(import.meta.dirname, "..");
const specs = [];
for (const file of await readdir(resolve(root, "models")))
  if (file.endsWith(".json"))
    specs.push(
      JSON.parse(await readFile(resolve(root, "models", file), "utf8")),
    );
await mkdir(resolve(root, ".generated"), { recursive: true });
await writeFile(
  resolve(root, ".generated/models.js"),
  "export default " + JSON.stringify(specs) + ";\n",
);
const options = {
  entryPoints: [resolve(root, "src/ui/app.js")],
  bundle: true,
  outfile: resolve(root, ".generated/app.js"),
  format: "iife",
  platform: "browser",
  target: "es2022",
  minify: false,
  plugins: [
    {
      name: "pdf-worker-text",
      setup(build) {
        build.onLoad({ filter: /pdf\.worker\.min\.mjs$/ }, async (args) => ({
          contents: await readFile(args.path, "utf8"),
          loader: "text",
        }));
      },
    },
  ],
};
async function singleFile() {
  const template = await readFile(resolve(root, "index.html"), "utf8"),
    css = await readFile(resolve(root, "src/ui/styles.css"), "utf8"),
    script = await readFile(resolve(root, ".generated/app.js"), "utf8");
  await writeFile(
    resolve(root, "chipsim.html"),
    template
      .replace(
        /<link\s+rel="stylesheet"\s+href="src\/ui\/styles\.css"\s*\/?>/,
        () => "<style>" + css + "</style>",
      )
      .replace(
        '<script src=".generated/app.js" defer></script>',
        () =>
          "<script>" +
          script.replace(/<\/script/gi, "<\\/script") +
          "</script>",
      ),
  );
}
if (process.argv.includes("--watch")) {
  const watcher = await context({
    ...options,
    plugins: [
      ...options.plugins,
      {
        name: "offline-copy",
        setup(build) {
          build.onEnd(async (result) => {
            if (!result.errors.length) await singleFile();
          });
        },
      },
    ],
  });
  await watcher.watch();
  await createServer(root);
  console.log("Watching source files.");
} else {
  await build(options);
  await singleFile();
  console.log("Built .generated/app.js and portable chipsim.html");
}
