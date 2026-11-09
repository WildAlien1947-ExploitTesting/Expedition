import { Controller } from "@mercuryworkshop/scramjet-controller";
import {
  CatchEscapedLinksPlugin,
  UrlWatcherPlugin,
} from "@mercuryworkshop/scramjet-utils";

const DEFAULT_WISP_URL = "wss://wisp.mercurywork.shop/";
const SETTINGS_KEY = "expedition-browser-settings";

const shell = document.querySelector(".browser-shell");
const status = document.querySelector("#connection-status");
const statusLabel = document.querySelector("#status-label");
const addressInput = document.querySelector("#address-input");
const startSearchInput = document.querySelector("#start-search-input");
const frameElement = document.querySelector("#browser-frame");
const loadingIndicator = document.querySelector("#loading-indicator");
const errorMessage = document.querySelector("#browser-error");
const settingsDialog = document.querySelector("#settings-dialog");
const wispInput = document.querySelector("#wisp-input");
const settingsMessage = document.querySelector("#settings-message");
const backButton = document.querySelector("#back-button");
const forwardButton = document.querySelector("#forward-button");
const reloadButton = document.querySelector("#reload-button");
const tabTitle = document.querySelector("#tab-title");

let controller;
let frame;
let LibcurlClient;
let proxyTransport;
let transportInitialization;
let settings = readSettings();
let loadTimer;
const deferredTransport = {
  ready: true,
  async init() {},
  async meta() {},
  request() {
    throw new Error("The proxy transport has not been initialized.");
  },
  connect() {
    throw new Error("The proxy transport has not been initialized.");
  },
};

function readSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
    return {
      wispUrl: saved.wispUrl || DEFAULT_WISP_URL,
    };
  } catch (error) {
    console.error("Could not read browser settings:", error);
    return { wispUrl: DEFAULT_WISP_URL };
  }
}

function setStatus(message, state = "ready") {
  statusLabel.textContent = message;
  status.dataset.state = state;
}

function withTimeout(promise, message, milliseconds = 15000) {
  let timeout;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error(message)), milliseconds);
    }),
  ]).finally(() => clearTimeout(timeout));
}

function showError(message) {
  errorMessage.textContent = message;
  errorMessage.hidden = false;
  setStatus("Connection issue", "error");
}

function hideError() {
  errorMessage.hidden = true;
  errorMessage.textContent = "";
}

function setLoading(isLoading) {
  loadingIndicator.dataset.active = String(isLoading);
  document.querySelector(".browser-tab").dataset.loading = String(isLoading);
  if (isLoading) {
    clearTimeout(loadTimer);
    loadTimer = setTimeout(() => {
      setStatus("Still loading…", "ready");
    }, 9000);
  } else {
    clearTimeout(loadTimer);
  }
}

function normalizeWispUrl(value) {
  let normalized = value.trim();
  if (!normalized) {
    throw new TypeError("Enter a Wisp server URL.");
  }
  if (!/^wss?:\/\//i.test(normalized)) {
    normalized = `wss://${normalized}`;
  }

  const parsed = new URL(normalized);
  if (!["ws:", "wss:"].includes(parsed.protocol)) {
    throw new TypeError("The Wisp URL must use ws:// or wss://.");
  }
  if (location.protocol === "https:" && parsed.protocol !== "wss:") {
    throw new TypeError("Hosted pages require a secure wss:// Wisp endpoint.");
  }
  if (!parsed.pathname.endsWith("/")) {
    parsed.pathname += "/";
  }
  return parsed.toString();
}

function normalizeAddress(value) {
  const input = value.trim();
  if (!input) {
    return null;
  }
  if (/\s/.test(input)) {
    return new URL(`https://www.google.com/search?q=${encodeURIComponent(input)}`);
  }

  const hasWebProtocol = /^https?:\/\//i.test(input);
  const looksLikeHost =
    /^(localhost|(?:\d{1,3}\.){3}\d{1,3})(:\d+)?(?:\/|$)/i.test(input) ||
    /^[^./]+\.[a-z]{2,}(?::\d+)?(?:\/|$)/i.test(input);
  if (!hasWebProtocol && !looksLikeHost) {
    return new URL(`https://www.google.com/search?q=${encodeURIComponent(input)}`);
  }

  const url = new URL(hasWebProtocol ? input : `https://${input}`);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new TypeError("Only http:// and https:// addresses can be opened.");
  }
  return url;
}

async function waitForServiceWorker(registration) {
  setStatus("Waiting for service worker…", "loading");
  await withTimeout(
    navigator.serviceWorker.ready,
    "The service worker did not activate. Check that this site is served over HTTPS or localhost, then reload.",
  );
  if (navigator.serviceWorker.controller) {
    return navigator.serviceWorker.controller;
  }

  await new Promise((resolve) => {
    let timer;
    const onControllerChange = () => {
      clearTimeout(timer);
      resolve();
    };
    navigator.serviceWorker.addEventListener("controllerchange", onControllerChange, { once: true });
    timer = setTimeout(() => {
      navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange);
      resolve();
    }, 10000);
  });

  const serviceWorker = navigator.serviceWorker.controller || registration.active;
  if (!serviceWorker) {
    throw new Error("Scramjet's service worker did not become active. Reload this page and try again.");
  }
  return serviceWorker;
}

function makeEscapedLinkUrl(url) {
  const destination = new URL(location.href);
  destination.searchParams.set("goto", url.href);
  return destination;
}

function navigate(value) {
  let url;
  try {
    url = normalizeAddress(value);
  } catch (error) {
    showError(error.message);
    return;
  }
  if (!url) {
    return;
  }
  if (!controller || !frame) {
    showError("Scramjet is not ready yet. Wait for the connection status to turn green.");
    return;
  }

  hideError();
  shell.dataset.pageOpen = "true";
  addressInput.value = url.href;
  startSearchInput.value = url.href;
  tabTitle.textContent = url.hostname;
  document.title = `${url.hostname} — Expedition Browser`;
  setLoading(true);
  setStatus("Preparing proxy…", "loading");
  ensureProxyTransport()
    .then(() => {
      setStatus("Loading page…");
      frame.go(url.href);
    })
    .catch((error) => {
      setLoading(false);
      showError(error instanceof Error ? error.message : "Could not load the proxy transport.");
    });
}

async function ensureProxyTransport() {
  if (!LibcurlClient) {
    transportInitialization ??= import("@mercuryworkshop/libcurl-transport")
      .then((module) => {
        LibcurlClient = module.default;
      })
      .catch((error) => {
        transportInitialization = undefined;
        throw error;
      });
    await transportInitialization;
  }
  if (!proxyTransport || proxyTransport.wisp !== settings.wispUrl) {
    proxyTransport = new LibcurlClient({ wisp: settings.wispUrl });
    controller.setTransport(proxyTransport);
  }
}

function openStartPage() {
  shell.dataset.pageOpen = "false";
  addressInput.value = "";
  startSearchInput.value = "";
  tabTitle.textContent = "New tab";
  document.title = "Expedition Browser";
  hideError();
  setLoading(false);
  setStatus(controller ? "Ready to browse" : "Starting Scramjet…", controller ? "ready" : "loading");
  startSearchInput.focus();
}

function openSettings() {
  wispInput.value = settings.wispUrl;
  settingsMessage.hidden = true;
  settingsMessage.textContent = "";
  settingsDialog.showModal();
}

async function initialize() {
  if (!window.isSecureContext || !("serviceWorker" in navigator)) {
    throw new Error("Scramjet requires HTTPS or localhost and service worker support.");
  }
  if (!window.$scramjetController || typeof window.$scramjetController.Controller !== "function") {
    throw new Error("Scramjet browser assets did not load. Check the server's /controller and /scramjet routes.");
  }

  setStatus("Installing browser engine…", "loading");
  const registration = await navigator.serviceWorker.register("./sw.js", { scope: "./" });
  const serviceWorker = await waitForServiceWorker(registration);
  const proxyPrefix = new URL("./~/sj/", registration.scope).pathname;
  setStatus("Checking Scramjet runtime…", "loading");
  window.$scramjetController.assertRuntimeScramjetVersion();
  setStatus("Connecting to service worker…", "loading");
  controller = new Controller({
    serviceworker: serviceWorker,
    transport: deferredTransport,
    config: {
      prefix: proxyPrefix,
      scramjetPath: "/scramjet/scramjet.js",
      wasmPath: "/scramjet/scramjet.wasm",
    },
  });
  await withTimeout(
    controller.wait(),
    "Scramjet's service worker did not respond. Reload the page to retry.",
  );

  frame = controller.createFrame(frameElement, {
    plugins: [
      new UrlWatcherPlugin((url) => {
        addressInput.value = url;
        try {
          tabTitle.textContent = new URL(url).hostname || "New tab";
        } catch {
          tabTitle.textContent = "Web page";
        }
      }),
      new CatchEscapedLinksPlugin(makeEscapedLinkUrl),
    ],
  });

  backButton.disabled = false;
  forwardButton.disabled = false;
  reloadButton.disabled = false;
  frameElement.addEventListener("load", () => {
    setLoading(false);
    setStatus("Ready to browse");
  });
  setStatus("Ready to browse");

  const initialUrl = new URL(location.href).searchParams.get("goto");
  if (initialUrl) {
    history.replaceState(null, "", location.pathname);
    navigate(initialUrl);
  }
}

document.querySelector("#address-form").addEventListener("submit", (event) => {
  event.preventDefault();
  navigate(addressInput.value);
});

document.querySelector("#start-search-form").addEventListener("submit", (event) => {
  event.preventDefault();
  navigate(startSearchInput.value);
});

document.querySelectorAll(".quick-links [data-url]").forEach((button) => {
  button.addEventListener("click", () => navigate(button.dataset.url));
});

backButton.addEventListener("click", () => frame?.back());
forwardButton.addEventListener("click", () => frame?.forward());
reloadButton.addEventListener("click", () => {
  if (frame) {
    setLoading(true);
    frame.reload();
  }
});
document.querySelector("#home-button").addEventListener("click", openStartPage);
document.querySelector("#new-tab-button").addEventListener("click", openStartPage);
document.querySelector("#settings-trigger").addEventListener("click", openSettings);
document.querySelector("#footer-settings").addEventListener("click", openSettings);
document.querySelector("#settings-close").addEventListener("click", () => settingsDialog.close());
document.querySelector("#settings-cancel").addEventListener("click", () => settingsDialog.close());

document.querySelector("#settings-form").addEventListener("submit", (event) => {
  event.preventDefault();
  settingsMessage.hidden = true;
  try {
    const wispUrl = normalizeWispUrl(wispInput.value);
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ wispUrl }));
    settings = { wispUrl };
    if (LibcurlClient && controller) {
      proxyTransport = new LibcurlClient({ wisp: wispUrl });
      controller.setTransport(proxyTransport);
    }
    setStatus("Connection settings saved");
    settingsDialog.close();
  } catch (error) {
    settingsMessage.textContent = error.message;
    settingsMessage.hidden = false;
  }
});

document.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "l") {
    event.preventDefault();
    addressInput.focus();
    addressInput.select();
  }
  if (event.key === "Escape" && settingsDialog.open) {
    settingsDialog.close();
  }
});

initialize().catch((error) => {
  console.error("Could not start Scramjet:", error);
  showError(error instanceof Error ? error.message : "Scramjet failed to start.");
});
