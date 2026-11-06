// Navegação entre as telas do side panel. O chat é a principal; as outras
// abrem por cima e voltam para ele.

export type View = "chat" | "history" | "settings" | "control";
const VIEWS: View[] = ["chat", "history", "settings", "control"];
const listeners: ((v: View) => void)[] = [];

export function show(view: View): void {
  for (const v of VIEWS) document.getElementById(`view-${v}`)!.hidden = v !== view;
  for (const fn of listeners) fn(view);
}

export function onShow(fn: (v: View) => void): void {
  listeners.push(fn);
}

for (const b of document.querySelectorAll<HTMLButtonElement>("button.back")) b.addEventListener("click", () => show("chat"));
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && document.getElementById("view-chat")!.hidden) show("chat");
});
