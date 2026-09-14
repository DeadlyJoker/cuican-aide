import { createContext } from "react";
import type { DeliveryControlClient } from "@crewon/control-client";

export const DeliveryClientContext =
  createContext<DeliveryControlClient | null>(null);
