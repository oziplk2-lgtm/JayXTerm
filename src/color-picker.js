import { clampSamplePoint, rgbToHex } from "./color-picker-utils.mjs";

const screenCanvas = document.getElementById("screen");
const screenCtx = screenCanvas.getContext("2d", { willReadFrequently: true });
const loupe = document.getElementById("loupe");
const zoomCanvas = document.getElementById("zoom");
const zoomCtx = zoomCanvas.getContext("2d");
const swatch = document.getElementById("swatch");
const hexLabel = document.getElementById("hex");

let ready = false;
let currentHex = "#394351";

function updateAt(clientX, clientY) {
  if (!ready) return;
  const { x, y } = clampSamplePoint(
    clientX,
    clientY,
    window.innerWidth,
    window.innerHeight,
    screenCanvas.width,
    screenCanvas.height,
  );
  const pixel = screenCtx.getImageData(x, y, 1, 1).data;
  currentHex = rgbToHex(pixel[0], pixel[1], pixel[2]);
  swatch.style.backgroundColor = currentHex;
  hexLabel.textContent = currentHex.toUpperCase();

  // Draw an 11x11 pixel grid centered on the sampled pixel.
  const grid = 11;
  const half = 5;
  const size = zoomCanvas.width;
  const cell = size / grid;
  zoomCtx.clearRect(0, 0, size, size);
  zoomCtx.fillStyle = "#000";
  zoomCtx.fillRect(0, 0, size, size);
  zoomCtx.imageSmoothingEnabled = false;
  const sx = Math.max(0, x - half);
  const sy = Math.max(0, y - half);
  const sw = Math.min(screenCanvas.width - sx, x + half + 1 - sx);
  const sh = Math.min(screenCanvas.height - sy, y + half + 1 - sy);
  const dx = (sx - (x - half)) * cell;
  const dy = (sy - (y - half)) * cell;
  zoomCtx.drawImage(screenCanvas, sx, sy, sw, sh, dx, dy, sw * cell, sh * cell);

  zoomCtx.strokeStyle = "rgba(255,255,255,0.16)";
  zoomCtx.lineWidth = 1;
  for (let i = 1; i < grid; i++) {
    const pos = Math.round(i * cell) + 0.5;
    zoomCtx.beginPath();
    zoomCtx.moveTo(pos, 0);
    zoomCtx.lineTo(pos, size);
    zoomCtx.moveTo(0, pos);
    zoomCtx.lineTo(size, pos);
    zoomCtx.stroke();
  }
  const center = half * cell;
  zoomCtx.strokeStyle = "#ffffff";
  zoomCtx.lineWidth = 2;
  zoomCtx.strokeRect(center + 1, center + 1, cell - 2, cell - 2);
  zoomCtx.strokeStyle = "#000000";
  zoomCtx.lineWidth = 1;
  zoomCtx.strokeRect(center, center, cell, cell);

  const boxWidth = 132;
  const boxHeight = 166;
  const margin = 18;
  const left = clientX + margin + boxWidth > window.innerWidth
    ? clientX - margin - boxWidth
    : clientX + margin;
  const top = clientY + margin + boxHeight > window.innerHeight
    ? clientY - margin - boxHeight
    : clientY + margin;
  loupe.style.left = `${Math.max(8, left)}px`;
  loupe.style.top = `${Math.max(8, top)}px`;
  loupe.style.display = "block";
}

window.colorPickerApi.onInit(({ dataUrl, width, height }) => {
  const image = new Image();
  image.onload = () => {
    screenCanvas.width = width || image.naturalWidth;
    screenCanvas.height = height || image.naturalHeight;
    screenCtx.drawImage(image, 0, 0, screenCanvas.width, screenCanvas.height);
    ready = true;
  };
  image.onerror = () => window.colorPickerApi.finish(null);
  image.src = dataUrl;
});
window.colorPickerApi.ready();

window.addEventListener("mousemove", (event) => updateAt(event.clientX, event.clientY));
window.addEventListener("mousedown", (event) => {
  if (event.button === 0 && ready) {
    updateAt(event.clientX, event.clientY);
    window.colorPickerApi.finish(currentHex);
  } else if (event.button === 2) {
    window.colorPickerApi.finish(null);
  }
});
window.addEventListener("contextmenu", (event) => {
  event.preventDefault();
  window.colorPickerApi.finish(null);
});
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    event.preventDefault();
    window.colorPickerApi.finish(null);
  }
});
