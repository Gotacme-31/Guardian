import axios from "axios";
import { sharedValue } from "@guardian/shared";

export const result = axios.get(`/values/${sharedValue}`);
