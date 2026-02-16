export function registerGameModule({ slug, logger }) {
  logger.info?.(`[games] '${slug}' module registered (compat mode).`);
}
