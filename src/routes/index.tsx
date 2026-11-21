import { createFileRoute } from "@tanstack/react-router";
import { LaneApp } from "@/components/lane-app";

export const Route = createFileRoute("/")({ component: Home });

function Home() {
  return <LaneApp />;
}
