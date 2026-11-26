export async function activate(api) {
  api.ui.registerSettingsPanel({
    id: "fonts",
    title: "Fonts",
    description: "Manage imported TrueType fonts and choose the font used by Yapin'.",
    icon: "palette",
    items: [
      {
        type: "toggle",
        id: "apply",
        label: "Apply selected font",
        description: "Use the selected TTF font throughout the app while Fonts is enabled.",
        defaultValue: true
      }
    ]
  });
}
