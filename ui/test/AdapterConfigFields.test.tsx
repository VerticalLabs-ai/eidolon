import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { AdapterConfigFields } from "../src/components/runtime/AdapterConfigFields";
import {
  configForAdapter,
  validateAdapterConfig,
  type RuntimeAdapterConfig,
} from "../src/lib/runtime-adapters";
import type {
  RuntimeAdapterConfigField,
  RuntimeAdapterDescriptor,
} from "../src/lib/api";

const fields: RuntimeAdapterConfigField[] = [
  { key: "url", label: "Endpoint URL", type: "url", required: true },
  { key: "timeoutSec", label: "Timeout", type: "number", defaultValue: 30, min: 1, max: 300 },
  { key: "responseFields", label: "Response fields", type: "string-list" },
  { key: "deliver", label: "Deliver response", type: "boolean", defaultValue: true },
];

const adapter = {
  id: "openclaw:webhook",
  name: "OpenClaw webhook",
  configFields: fields,
} as RuntimeAdapterDescriptor;

function ControlledFields() {
  const [value, setValue] = useState<RuntimeAdapterConfig>(() =>
    configForAdapter(adapter, {}),
  );
  return (
    <>
      <AdapterConfigFields fields={fields} value={value} onChange={setValue} />
      <output data-testid="config">{JSON.stringify(value)}</output>
    </>
  );
}

describe("AdapterConfigFields", () => {
  it("edits typed adapter fields without raw JSON", async () => {
    const user = userEvent.setup();
    render(<ControlledFields />);

    await user.type(screen.getByLabelText("Endpoint URL"), "https://runtime.example.com/hook");
    await user.clear(screen.getByLabelText("Timeout"));
    await user.type(screen.getByLabelText("Timeout"), "45");
    await user.type(screen.getByLabelText("Response fields"), "status, summary");
    await user.click(screen.getByLabelText("Deliver response"));

    expect(screen.getByTestId("config")).toHaveTextContent(
      JSON.stringify({
        url: "https://runtime.example.com/hook",
        timeoutSec: 45,
        responseFields: ["status", "summary"],
        deliver: false,
      }),
    );
  });

  it("applies defaults and validates required, URL, and numeric constraints", () => {
    expect(configForAdapter(adapter, {})).toEqual({
      url: "",
      timeoutSec: 30,
      responseFields: [],
      deliver: true,
    });
    expect(
      configForAdapter(adapter, {
        url: "https://runtime.example.com",
        secretRef: "vault://runtime-token",
      }),
    ).toEqual({
      url: "https://runtime.example.com",
      timeoutSec: 30,
      responseFields: [],
      deliver: true,
      secretRef: "vault://runtime-token",
    });
    expect(validateAdapterConfig(adapter, configForAdapter(adapter, {}))).toBe(
      "Endpoint URL is required for OpenClaw webhook.",
    );
    expect(validateAdapterConfig(adapter, { url: "file:///tmp/agent", timeoutSec: 30 })).toBe(
      "Endpoint URL must use http or https.",
    );
    expect(validateAdapterConfig(adapter, { url: "https://runtime.example.com", timeoutSec: 301 })).toBe(
      "Timeout must be at most 300.",
    );
    expect(validateAdapterConfig(adapter, { url: "https://runtime.example.com", timeoutSec: 30 })).toBeNull();
  });

  it("renders omitted boolean defaults and commits list drafts on Enter", async () => {
    const user = userEvent.setup();
    render(<ControlledFields />);

    expect(screen.getByLabelText("Deliver response")).toBeChecked();
    await user.type(screen.getByLabelText("Response fields"), "status, summary{Enter}");

    expect(screen.getByTestId("config")).toHaveTextContent(
      JSON.stringify({
        url: "",
        timeoutSec: 30,
        responseFields: ["status", "summary"],
        deliver: true,
      }),
    );
  });
});
