import "./style.css";
import { initTelemetry, showBootError } from "./telemetry.js";

const GAME = "trivia";
initTelemetry(GAME);

import("./app.js").catch((err) => showBootError(GAME, err));
