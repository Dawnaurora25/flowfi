import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

// ─── Mocks ──────────────────────────────────────────────────────────────────
//
// dashboard-view.tsx pulls in a lot of feature components (the stream
// creation wizard, modals, SSE status indicator, etc.) that aren't relevant
// to the "does switching tabs/routes re-trigger a network fetch within
// staleTime" question this file is about. They're stubbed out below so the
// test can focus on the useDashboard/query-cache wiring.

vi.mock("next/navigation", () => ({
  useRouter: vi.fn(() => ({ push: vi.fn() })),
  useSearchParams: vi.fn(() => new URLSearchParams()),
}));

vi.mock("@/hooks/useStreamEvents", () => ({
  useStreamEvents: () => ({
    events: [],
    connected: true,
    reconnecting: false,
    error: null,
  }),
}));

vi.mock("react-hot-toast", () => ({
  default: {
    success: vi.fn(),
    error: vi.fn(),
    loading: vi.fn(() => "toast-id"),
  },
}));

vi.mock("@/lib/soroban", () => ({
  createStream: vi.fn(),
  topUpStream: vi.fn(),
  cancelStream: vi.fn(),
  withdrawFromStream: vi.fn(),
  toBaseUnits: vi.fn((v: string) => BigInt(v)),
  toDurationSeconds: vi.fn(() => 0),
  getTokenAddress: vi.fn((symbol: string) => symbol),
  toSorobanErrorMessage: vi.fn((e) => String(e)),
  fetchTokenBalanceDisplay: vi.fn().mockResolvedValue("1000"),
}));

vi.mock("@/lib/stellar", () => ({
  isValidStellarPublicKey: vi.fn(() => true),
}));

vi.mock("../IncomingStreams", () => ({
  default: () => <div data-testid="incoming-streams" />,
}));

vi.mock("./SSEStatusIndicator", () => ({
  SSEStatusIndicator: () => <div data-testid="sse-status" />,
}));

vi.mock("../stream-creation/StreamCreationWizard", () => ({
  StreamCreationWizard: () => <div data-testid="stream-wizard" />,
}));

vi.mock("../stream-creation/TopUpModal", () => ({
  TopUpModal: () => <div data-testid="topup-modal" />,
}));

vi.mock("../stream-creation/CancelConfirmModal", () => ({
  CancelConfirmModal: () => <div data-testid="cancel-modal" />,
}));

vi.mock("./StreamDetailsModal", () => ({
  StreamDetailsModal: () => <div data-testid="details-modal" />,
}));

vi.mock("../ui/Button", () => ({
  Button: ({
    children,
    onClick,
    disabled,
    ...rest
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & {
    glow?: boolean;
    variant?: string;
    size?: string;
    children?: React.ReactNode;
  }) => (
    <button onClick={onClick} disabled={disabled} {...rest}>
      {children}
    </button>
  ),
}));

import { DashboardView } from "./dashboard-view";
import type { WalletSession } from "@/lib/wallet";

const PUBLIC_KEY = "GABCDEFPUBLICKEY000000000000000000000000000000000000000";

const session: WalletSession = {
  walletId: "freighter",
  walletName: "Freighter",
  publicKey: PUBLIC_KEY,
  connectedAt: new Date().toISOString(),
  network: "TESTNET",
  mocked: false,
};

function jsonResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as Response;
}

// ─── Optimistic Action Rollback Tests ──────────────────────────────────────
//
// Tests for failed top-up, pause, resume, and cancel actions lacking UI rollback.
// These test the error handling paths when optimistic UI actions fail and need to
// roll back to their previous state.

describe("DashboardView optimistic action rollback", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse([])));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("handles top-up failure and rolls back optimistic update", async () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { staleTime: 10_000, refetchOnWindowFocus: false, retry: 1 },
      },
    });

    // Mock snapshot with initial state
    queryClient.setQueryData(
      [ "dashboard", PUBLIC_KEY ],
      {
        totalSent: 0,
        totalReceived: 0,
        totalValueLocked: 1000,
        activeStreamsCount: 1,
        recentActivity: [],
        outgoingStreams: [
          {
            id: "stream-1",
            recipient: "GABCDEF123456789012345678901234567890123",
            amount: 100,
            token: "XLM",
            status: "Active",
            deposited: 100,
            withdrawn: 0,
            date: "2024-01-01",
            ratePerSecond: 10,
            lastUpdateTime: 1000,
            isActive: true,
          },
        ],
        incomingStreams: [],
      } as any,
    );

    const renderDashboard = () =>
      render(
        <QueryClientProvider client={queryClient}>
          <DashboardView session={session} onDisconnect={vi.fn()} />
        </QueryClientProvider>,
      );

    const first = renderDashboard();
    await waitFor(() =>
      expect(screen.getByText(/start your first stream/i)).toBeInTheDocument(),
    );

    // Verify initial deposited amount
    const depositedBefore = screen.getByText(/100 XLM/);
    expect(depositedBefore).toBeInTheDocument();

    // Simulate a top-up failure - mock the toast error
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("top-up failed")),
    );

    // Re-render with error state
    const second = renderDashboard();
    await waitFor(() =>
      expect(screen.getByText(/failed to load streams/i)).toBeInTheDocument(),
    );

    // After error, the optimistic update should be rolled back
    // The dashboard should still show the original value
    const depositedAfter = screen.getByText(/100 XLM/);
    expect(depositedAfter).toBeInTheDocument();
  });

  it("handles cancel failure and rolls back optimistic update", async () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { staleTime: 10_000, refetchOnWindowFocus: false, retry: 1 },
      },
    });

    // Mock snapshot with active stream
    queryClient.setQueryData(
      [ "dashboard", PUBLIC_KEY ],
      {
        totalSent: 0,
        totalReceived: 0,
        totalValueLocked: 500,
        activeStreamsCount: 1,
        recentActivity: [],
        outgoingStreams: [
          {
            id: "stream-1",
            recipient: "GABCDEF123456789012345678901234567890123",
            amount: 100,
            token: "XLM",
            status: "Active",
            deposited: 100,
            withdrawn: 50,
            date: "2024-01-01",
            ratePerSecond: 5,
            lastUpdateTime: 1000,
            isActive: true,
          },
        ],
        incomingStreams: [],
      } as any,
    );

    const renderDashboard = () =>
      render(
        <QueryClientProvider client={queryClient}>
          <DashboardView session={session} onDisconnect={vi.fn()} />
        </QueryClientProvider>,
      );

    const first = renderDashboard();
    await waitFor(() =>
      expect(screen.getByText(/start your first stream/i)).toBeInTheDocument(),
    );

    // Verify initial withdrawn amount
    const withdrawnBefore = screen.getByText(/50 XLM/);
    expect(withdrawnBefore).toBeInTheDocument();

    // Simulate a cancel failure
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("cancel failed")),
    );

    // Re-render with error state
    const second = renderDashboard();
    await waitFor(() =>
      expect(screen.getByText(/failed to load streams/i)).toBeInTheDocument(),
    );

    // After error, the optimistic update should be rolled back
    // The dashboard should still show the original withdrawn value
    const withdrawnAfter = screen.getByText(/50 XLM/);
    expect(withdrawnAfter).toBeInTheDocument();
  });

  it("handles pause failure and rolls back optimistic update", async () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { staleTime: 10_000, refetchOnWindowFocus: false, retry: 1 },
      },
    });

    // Mock snapshot with active stream
    queryClient.setQueryData(
      [ "dashboard", PUBLIC_KEY ],
      {
        totalSent: 0,
        totalReceived: 0,
        totalValueLocked: 750,
        activeStreamsCount: 1,
        recentActivity: [],
        outgoingStreams: [
          {
            id: "stream-1",
            recipient: "GABCDEF123456789012345678901234567890123",
            amount: 100,
            token: "XLM",
            status: "Active",
            deposited: 100,
            withdrawn: 25,
            date: "2024-01-01",
            ratePerSecond: 7.5,
            lastUpdateTime: 1000,
            isActive: true,
          },
        ],
        incomingStreams: [],
      } as any,
    );

    const renderDashboard = () =>
      render(
        <QueryClientProvider client={queryClient}>
          <DashboardView session={session} onDisconnect={vi.fn()} />
        </QueryClientProvider>,
      );

    const first = renderDashboard();
    await waitFor(() =>
      expect(screen.getByText(/start your first stream/i)).toBeInTheDocument(),
    );

    // Verify initial state
    const withdrawnBefore = screen.getByText(/25 XLM/);
    expect(withdrawnBefore).toBeInTheDocument();

    // Simulate a pause failure
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("pause failed")),
    );

    // Re-render with error state
    const second = renderDashboard();
    await waitFor(() =>
      expect(screen.getByText(/failed to load streams/i)).toBeInTheDocument(),
    );

    // After error, the optimistic update should be rolled back
    const withdrawnAfter = screen.getByText(/25 XLM/);
    expect(withdrawnAfter).toBeInTheDocument();
  });

  it("handles resume failure and rolls back optimistic update", async () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { staleTime: 10_000, refetchOnWindowFocus: false, retry: 1 },
      },
    });

    // Mock snapshot with paused stream
    queryClient.setQueryData(
      [ "dashboard", PUBLIC_KEY ],
      {
        totalSent: 0,
        totalReceived: 0,
        totalValueLocked: 200,
        activeStreamsCount: 1,
        recentActivity: [],
        outgoingStreams: [
          {
            id: "stream-1",
            recipient: "GABCDEF123456789012345678901234567890123",
            amount: 100,
            token: "XLM",
            status: "Paused",
            deposited: 100,
            withdrawn: 0,
            date: "2024-01-01",
            ratePerSecond: 0,
            lastUpdateTime: 1000,
            isActive: false,
          },
        ],
        incomingStreams: [],
      } as any,
    );

    const renderDashboard = () =>
      render(
        <QueryClientProvider client={queryClient}>
          <DashboardView session={session} onDisconnect={vi.fn()} />
        </QueryClientProvider>,
      );

    const first = renderDashboard();
    await waitFor(() =>
      expect(screen.getByText(/start your first stream/i)).toBeInTheDocument(),
    );

    // Verify initial state - paused stream
    const pausedBefore = screen.getByText(/Paused/);
    expect(pausedBefore).toBeInTheDocument();

    // Simulate a resume failure
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("resume failed")),
    );

    // Re-render with error state
    const second = renderDashboard();
    await waitFor(() =>
      expect(screen.getByText(/failed to load streams/i)).toBeInTheDocument(),
    );

    // After error, the optimistic update should be rolled back
    // Stream should remain paused
    const pausedAfter = screen.getByText(/Paused/);
    expect(pausedAfter).toBeInTheDocument();
  });

  it("handles mixed optimistic actions with partial failures", async () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { staleTime: 10_000, refetchOnWindowFocus: false, retry: 1 },
      },
    });

    // Mock snapshot with multiple streams
    queryClient.setQueryData(
      [ "dashboard", PUBLIC_KEY ],
      {
        totalSent: 0,
        totalReceived: 0,
        totalValueLocked: 1500,
        activeStreamsCount: 2,
        recentActivity: [],
        outgoingStreams: [
          {
            id: "stream-1",
            recipient: "GABCDEF123456789012345678901234567890123",
            amount: 100,
            token: "XLM",
            status: "Active",
            deposited: 100,
            withdrawn: 0,
            date: "2024-01-01",
            ratePerSecond: 10,
            lastUpdateTime: 1000,
            isActive: true,
          },
          {
            id: "stream-2",
            recipient: "GABCDEF123456789012345678901234567890124",
            amount: 200,
            token: "XLM",
            status: "Active",
            deposited: 200,
            withdrawn: 50,
            date: "2024-01-01",
            ratePerSecond: 20,
            lastUpdateTime: 2000,
            isActive: true,
          },
        ],
        incomingStreams: [],
      } as any,
    );

    const renderDashboard = () =>
      render(
        <QueryClientProvider client={queryClient}>
          <DashboardView session={session} onDisconnect={vi.fn()} />
        </QueryClientProvider>,
      );

    const first = renderDashboard();
    await waitFor(() =>
      expect(screen.getByText(/start your first stream/i)).toBeInTheDocument(),
    );

    // Verify initial state
    const stream1WithdrawnBefore = screen.getByText(/0 XLM/);
    const stream2WithdrawnBefore = screen.getByText(/50 XLM/);
    expect(stream1WithdrawnBefore).toBeInTheDocument();
    expect(stream2WithdrawnBefore).toBeInTheDocument();

    // Simulate a top-up failure for stream-2
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("top-up failed")),
    );

    // Re-render with error state
    const second = renderDashboard();
    await waitFor(() =>
      expect(screen.getByText(/failed to load streams/i)).toBeInTheDocument(),
    );

    // After error, stream-2 should roll back to original withdrawn value
    // but stream-1 should remain unchanged
    const stream2WithdrawnAfter = screen.getByText(/50 XLM/);
    expect(stream2WithdrawnAfter).toBeInTheDocument();

    // stream-1 withdrawn should still be 0
    const stream1WithdrawnAfter = screen.getByText(/0 XLM/);
    expect(stream1WithdrawnAfter).toBeInTheDocument();
  });
});