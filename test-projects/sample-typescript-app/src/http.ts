import axios from "axios";
import { AxiosError as HttpError } from "axios";
import map from "lodash/map";
import { helper } from "@app/helper";
import { relativeValue } from "./relative.js";

export const client = axios;
export const errorType = HttpError;
export const mapped = map([relativeValue], helper);
