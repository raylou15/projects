export function registerGameModule({ slug, app, logger }) {
  app.get(`/api/games/${slug}/health`, (_req, res) => {
    res.send({ ok: true, slug, status: "stub" });
  });

  logger.info?.(`[games] '${slug}' module registered (stub).`);
}
