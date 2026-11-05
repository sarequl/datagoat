import { describe, expect, it } from "vitest";
import { busiest, locationToAngles } from "../../analytics/components/Globe";

describe("globe start position", () => {
  it("faces the spot with the most visitors", () => {
    const dhaka = { lat: 23.8, lng: 90.4 };
    const chittagong = { lat: 22.3, lng: 91.8 };
    const nyc = { lat: 40.7, lng: -74 };
    const spot = busiest([nyc, dhaka, chittagong]);
    expect(spot.lat).toBeCloseTo(23.05, 1);
    expect(spot.lng).toBeCloseTo(91.1, 1);
    expect(busiest([nyc])).toEqual(nyc);
  });

  it("turns cobe's angles toward a location", () => {
    const [phi, theta] = locationToAngles(0, 90);
    expect(phi).toBeCloseTo(Math.PI, 5);
    expect(theta).toBe(0);
  });
});
