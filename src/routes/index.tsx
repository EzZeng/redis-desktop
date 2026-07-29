import { createFileRoute } from "@tanstack/react-router";
import { RedisDesktop } from "@/components/redis/RedisDesktop";

export const Route = createFileRoute("/")({
  component: HomePage,
});

function HomePage() {
  return <RedisDesktop />;
}
