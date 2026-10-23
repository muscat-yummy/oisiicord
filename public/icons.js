const paths = {
  up: ["m6 14 6-6 6 6"],
  down: ["m6 10 6 6 6-6"],
  history: ["M3 11a9 9 0 1 1 2 7M3 4v7h7M12 7v5l3 2"],
  info: ["M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0ZM12 11v6M12 7h.01"],
  hash: ["M4 9h16M3 15h16M10 3 8 21M16 3l-2 18"],
  volume: [
    "m11 5-6 4H2v6h3l6 4V5Z",
    "M15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14",
  ],
  mic: [
    "M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z",
    "M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8",
  ],
  micOff: [
    "m2 2 20 20M9 9v3a3 3 0 0 0 5 2M15 9V5a3 3 0 0 0-5.4-1.8",
    "M5 10v2a7 7 0 0 0 12 4.9M19 10v2M12 19v3M8 22h8",
  ],
  headphones: [
    "M3 14v-3a9 9 0 0 1 18 0v3",
    "M3 13h4v8H5a2 2 0 0 1-2-2v-6ZM21 13h-4v8h2a2 2 0 0 0 2-2v-6Z",
  ],
  headphonesOff: [
    "M3 14v-3a9 9 0 0 1 .5-3M6.1 4.2A9 9 0 0 1 21 11v3",
    "M3 13h4v8H5a2 2 0 0 1-2-2v-6ZM17 16v5h2a2 2 0 0 0 2-2",
    "m2 2 20 20",
  ],
  settings: [
    "M9 3h6l.6 2.4 2 .9 2.2-.7 3 5.2-1.8 1.7.1 2.2 1.7 1.8-3 5.2-2.3-.7-2 .9L15 24H9l-.6-2.4-2-.9-2.3.7-3-5.2 1.8-1.7-.1-2.3-1.7-1.7 3-5.2 2.3.7 2-.9L9 3Z",
    "M15.5 13.5a3.5 3.5 0 1 1-7 0 3.5 3.5 0 0 1 7 0Z",
  ],
  plus: ["M12 5v14M5 12h14"],
  plusCircle: ["M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0Z", "M12 7v10M7 12h10"],
  smile: [
    "M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0Z",
    "M8 9h.01M16 9h.01M7 14a5.5 5.5 0 0 0 10 0",
  ],
  send: ["m22 2-7 20-4-9L2 9 22 2ZM11 13 22 2"],
  pin: ["m16 3 5 5-4 1-3 5v4l-8-8h4l5-3 1-4ZM10 14l-7 7"],
  users: [
    "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M16 3a4 4 0 0 1 0 8M22 21v-2a4 4 0 0 0-3-3.9",
    "M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z",
  ],
  chevron: ["m6 9 6 6 6-6"],
  close: ["m6 6 12 12M6 18 18 6"],
  menu: ["M4 6h16M4 12h16M4 18h16"],
  phone: [
    "M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6 19.8 19.8 0 0 1-3.1-8.7A2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .3 2 .7 2.9a2 2 0 0 1-.5 2.1L8 10a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.5c.9.4 1.9.6 2.9.7a2 2 0 0 1 1.7 2Z",
  ],
  hangup: [
    "M3 15v4l5-1v-4a16 16 0 0 1 8 0v4l5 1v-4a2 2 0 0 0-.6-1.5 13 13 0 0 0-16.8 0A2 2 0 0 0 3 15Z",
  ],
  camera: [
    "M15 10 22 6v12l-7-4V10ZM3 5h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z",
  ],
  screen: ["M3 3h18v14H3zM8 21h8M12 17v4M8 10l4-4 4 4M12 6v8"],
  upload: ["M12 16V3m-5 5 5-5 5 5M3 15v6h18v-6"],
  image: ["M3 3h18v18H3zM3 16l6-6 6 6 3-3 3 3", "M18 7h.01"],
  edit: ["m16 3 5 5-12 12-6 1 1-6L16 3ZM13 6l5 5"],
  trash: ["M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"],
  logout: ["M9 21H3V3h6M9 12h13m-5-5 5 5-5 5"],
  bell: ["M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9ZM10 21h4"],
  lock: ["M5 10h14v11H5zM8 10V6a4 4 0 0 1 8 0v4M12 14v3"],
  monitor: ["M2 3h20v14H2zM8 21h8M12 17v4"],
  palette: [
    "M12 22a10 10 0 1 1 10-10c0 3-3 3-5 3-3 0-2 3-2 4s-1 3-3 3Z",
    "M7 9h.01M10 5h.01M16 6h.01M19 10h.01",
  ],
  keyboard: [
    "M2 5h20v14H2zM6 9h.01M10 9h.01M14 9h.01M18 9h.01M6 13h.01M10 13h.01M14 13h.01M18 13h.01M7 16h10",
  ],
  check: ["m4 12 5 5L20 6"],
  link: [
    "M10 13a5 5 0 0 0 7 0l4-4a5 5 0 0 0-7-7l-2 2M14 11a5 5 0 0 0-7 0l-4 4a5 5 0 0 0 7 7l2-2",
  ],
  copy: ["M9 9h13v13H9zM5 15H2V2h13v3"],
  search: ["M21 21l-5-5", "M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z"],
  shield: ["m12 2 9 4v6c0 6-9 10-9 10S3 18 3 12V6l9-4ZM8 12l3 3 5-6"],
  accessibility: ["M12 3h.01M4 7l8 2 8-2M12 9v5m0 0-5 7m5-7 5 7"],
};
export function icon(name, size = 22) {
  const ns = "http://www.w3.org/2000/svg",
    svg = document.createElementNS(ns, "svg");
  for (const [k, v] of Object.entries({
    viewBox: "0 0 26 26",
    width: size,
    height: size,
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "1.8",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    "aria-hidden": "true",
    class: "ui-icon",
  }))
    svg.setAttribute(k, String(v));
  for (const d of paths[name] ?? paths.hash) {
    const p = document.createElementNS(ns, "path");
    p.setAttribute("d", d);
    svg.append(p);
  }
  return svg;
}
export function setIcon(button, name, label) {
  button.replaceChildren(icon(name));
  button.title = label;
  button.setAttribute("aria-label", label);
}
