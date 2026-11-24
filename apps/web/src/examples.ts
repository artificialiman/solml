import launch from "../../../examples/token-launch.solml?raw";
import launchSheet from "../../../examples/token-launch.sss?raw";
import hold from "../../../examples/hold.solml?raw";
import broken from "../../../examples/broken.solml?raw";

export interface Example {
  id: string;
  label: string;
  contract: string;
  sheet: string;
}

export const EXAMPLES: Example[] = [
  { id: "hold", label: "Timed transfer", contract: hold, sheet: "/* No sheet needed: <hold> carries no bonds. */\n" },
  { id: "launch", label: "Token launch", contract: launch, sheet: launchSheet },
  { id: "broken", label: "Every error class", contract: broken, sheet: "" },
];
