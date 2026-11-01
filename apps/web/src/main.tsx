import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes, useParams } from "react-router-dom";
import { BotsProvider, DEFAULT_BOT, useBots } from "./bots/store";
import { Shell } from "./components/Layout";
import { AgentPage } from "./pages/Agent";
import { ClaimPage } from "./pages/Claim";
import { ChatPage } from "./pages/Send";
import { SentPage } from "./pages/Sent";
import "./styles.css";

const HOME = `/chat/${DEFAULT_BOT.id}`;

function ChatRoute() {
  const { botId } = useParams();
  const bot = useBots().getBot(botId);
  if (!bot) return <Navigate to={HOME} replace />;
  // Keyed so switching bots starts from that bot's own state.
  return <ChatPage key={bot.id} bot={bot} />;
}

function App() {
  return (
    <BotsProvider>
        <BrowserRouter>
          <Shell>
            <Routes>
              <Route path="/chat/:botId" element={<ChatRoute />} />
              <Route path="/agent" element={<AgentPage />} />
              <Route path="/claim" element={<ClaimPage />} />
              <Route path="/sent" element={<SentPage />} />
              <Route path="/send" element={<Navigate to={HOME} replace />} />
              <Route path="*" element={<Navigate to={HOME} replace />} />
            </Routes>
          </Shell>
        </BrowserRouter>
    </BotsProvider>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
