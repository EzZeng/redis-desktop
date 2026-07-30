import { createRoot } from "react-dom/client";
import { RedisDesktop } from "@/components/redis/RedisDesktop";
import "@/styles.css";

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(<RedisDesktop />);
}
