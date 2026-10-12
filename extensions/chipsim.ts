// Both Pi and prime-agent supply TypeBox through their native extension loader.
import { Type } from "typebox";
import { registerChipSim } from "../src/integrations/extension.js";

export default function (agent) {
  registerChipSim(agent, Type);
}
