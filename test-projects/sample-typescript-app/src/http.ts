import axios from "axios";
import { AxiosError as HttpError } from "axios";
import map from "lodash/map";
import { helper } from "@app/helper";
import { relativeValue } from "./relative.js";

export const client = axios;
export const errorType = HttpError;
export const mapped = map([relativeValue], helper);
export const users = axios.get("/users");
export const order = axios.post("/orders", { ready: true });
export const commonHeaders = axios.defaults.headers.common;
