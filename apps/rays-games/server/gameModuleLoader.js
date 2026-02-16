import fs from "fs";
import path from "path";
import { pathToFileURL } from "url";

export async function loadGameModules({ app, server, wss, logger = console, registerUpgradeHandler = () => {} }) {
  const modulesRoot = path.resolve(process.cwd(), "games");
  if (!fs.existsSync(modulesRoot)) {
    logger.info?.(`[games] No modules directory at ${modulesRoot}; skipping dynamic game module load.`);
    return [];
  }

  const slugs = fs
    .readdirSync(modulesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

  const loaded = [];
  for (const slug of slugs) {
    const modulePath = path.join(modulesRoot, slug, "server", "index.js");
    if (!fs.existsSync(modulePath)) continue;

    try {
      const imported = await import(pathToFileURL(modulePath).href);
      const register = imported.registerGameModule;
      if (typeof register === "function") {
        register({ slug, app, server, wss, logger, registerUpgradeHandler });
      }
      loaded.push(slug);
    } catch (error) {
      logger.error?.(`[games] Failed loading module '${slug}' from ${modulePath}`, error);
    }
  }

  if (loaded.length > 0) {
    logger.info?.(`[games] Loaded modules: ${loaded.join(", ")}`);
  }

  return loaded;
}
