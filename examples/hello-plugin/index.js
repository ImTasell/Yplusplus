/**
 * Hello! plays the user's selected startup sound once when the authenticated
 * Yapin' application becomes ready. Audio files are managed by the Y++ host;
 * this plugin never reads paths, URLs, or raw file data.
 */
export function activate(api) {
  if (!api.events || !api.audio) {
    throw new Error("The Hello! application event and audio APIs are unavailable.");
  }

  const unsubscribe = api.events.on("application.ready", () => {
    void api.audio.playStartup().catch((error) => {
      api.logger.warn("Could not play the selected startup sound.", {
        message: error instanceof Error ? error.message : String(error),
      });
    });
  });

  api.onCleanup(unsubscribe);
}
