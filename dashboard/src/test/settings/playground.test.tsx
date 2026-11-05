import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { server } from "../../mocks/node";
import { openPage, recordRequests, SITE } from "./helpers";

afterEach(() => server.events.removeAllListeners());

describe("API playground", () => {
  it("sends the chosen request with the session and shows the JSON and a curl command", async () => {
    const log = recordRequests();
    openPage(`/app/${SITE}/api-playground`);
    const endpoint = await screen.findByLabelText("Endpoint");
    await userEvent.selectOptions(endpoint, "/api/v1/analytics/referrers");
    const params = screen.getByLabelText("Parameters");
    expect(params).toHaveValue("limit=10");
    await userEvent.type(params, "\nfilter_country=US");
    const curl = screen.getByRole("figure", { name: "curl command" });
    expect(curl).toHaveTextContent("/api/v1/analytics/referrers?startAt=");
    expect(curl).toHaveTextContent("limit=10&filter_country=US");
    expect(curl).toHaveTextContent("Authorization: Bearer df_YOUR_WEBSITE_KEY");

    await userEvent.click(screen.getByRole("button", { name: "Send request" }));
    expect(await screen.findByTestId("playground-status")).toHaveTextContent("HTTP 200");
    const response = screen.getByRole("figure", { name: "response" });
    expect(within(response).getByText(/"referrer"/)).toBeInTheDocument();
    await waitFor(() => {
      const sent = log.find((r) => r.path.startsWith("/api/v1/analytics/referrers"));
      expect(sent?.path).toContain(`websiteId=${SITE}`);
      expect(sent?.path).toContain("filter_country=US");
    });
  });

  it("omits the date range for snapshot endpoints", async () => {
    openPage(`/app/${SITE}/api-playground`);
    await userEvent.selectOptions(
      await screen.findByLabelText("Endpoint"),
      "/api/v1/analytics/realtime",
    );
    expect(screen.queryByLabelText("startAt")).not.toBeInTheDocument();
    expect(screen.getByRole("figure", { name: "curl command" })).toHaveTextContent(
      'curl "http://localhost:3000/api/v1/analytics/realtime"',
    );
  });
});
