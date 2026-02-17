import fs from "fs";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function resolveModulesRoot(logger = console) {
  // Preferred: apps/rays-games/games (relative to this file at apps/rays-games/server)
  const candidates = [
    path.resolve(__dirname, "../games"),
    // Helpful fallbacks for alternate run locations / deployments
    path.resolve(process.cwd(), "apps/rays-games/games"),
    path.resolve(process.cwd(), "rays-games/games"),
    path.resolve(process.cwd(), "games"),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  logger.info?.(
    `[games] No modules directory found. Looked in: ${candidates.join(", ")}. Dynamic game module load skipped.`,
  );
  return "";
}

export async function loadGameModules({ app, server, wss, logger = console, registerUpgradeHandler = () => {} }) {
  const modulesRoot = resolveModulesRoot(logger);
  if (!modulesRoot) return [];

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
