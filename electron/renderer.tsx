import { createRoot } from "react-dom/client";
import { RedisDesktop } from "@/components/redis/RedisDesktop";
import "./app.css";

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(<RedisDesktop />);
}
