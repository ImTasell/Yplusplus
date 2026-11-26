/**
 * Hello! plays the user's selected startup sound once when the authenticated
 * Yapin' application becomes ready. Audio files are managed by the Y++ host;
 * this plugin never reads paths, URLs, or raw file data.
 */
export function activate(api) {
  if (!api.events || !api.audio) {
    throw new Error("The Hello! application event and audio APIs are unavailable.");
  }

  api.events.on("application.ready", () => {
    void api.audio.playStartup().catch(() => {
      // No configured audio or an autoplay restriction should not break Yapin'.
    });
  });
}
