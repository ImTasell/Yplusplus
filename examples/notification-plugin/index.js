/**
 * Example plugin entry contract.
 *
 * The sandbox adapter will provide the frozen window.yplusplus API before
 * evaluating this entry. This file intentionally imports no Electron or Node
 * APIs and demonstrates only the public capability facade.
 */
export async function activate() {
  if (!globalThis.yplusplus?.notifications) {
    throw new Error("Y++ notification capability was not granted.");
  }

  await globalThis.yplusplus.notifications.show({
    title: "Hello from Y++",
    message: "The plugin API and capability broker are connected.",
  });
}
