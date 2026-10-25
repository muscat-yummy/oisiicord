window.addEventListener("message", (event) => {
  if (
    event.source === parent &&
    event.data?.type === "display-diagram" &&
    typeof event.data.svg === "string" &&
    event.data.svg.length < 2000000
  ) {
    const background = event.data.theme === "light" ? "#ffffff" : "#202127";
    document.documentElement.style.backgroundColor = background;
    document.body.style.backgroundColor = background;
    document.body.innerHTML = event.data.svg;
  }
});
