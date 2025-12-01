import { useEffect, useMemo, useState, useRef } from "react"
import { useLiveQuery, eq } from "@tanstack/react-db"
import { authClient } from "@/lib/auth-client"
import {
  getChatThreadsCollection,
  getChatMessagesCollection,
} from "@/lib/collections"

async function createThread(title = "New chat") {
  const res = await fetch("/api/chat/mutations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "createThread", title }),
  })
  if (!res.ok) throw new Error("Failed to create chat")
  const json = (await res.json()) as {
    thread: { id: number; title: string; created_at?: string }
  }
  // Electric will sync automatically via the shape subscription
  return {
    ...json.thread,
    created_at: json.thread.created_at
      ? new Date(json.thread.created_at)
      : new Date(),
  }
}

async function addMessage({
  threadId,
  role,
  content,
}: {
  threadId: number
  role: "user" | "assistant"
  content: string
}) {
  const res = await fetch("/api/chat/mutations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      action: "addMessage",
      threadId,
      role,
      content,
    }),
  })
  if (!res.ok) throw new Error("Failed to add message")
  const json = (await res.json()) as { message: { id: number } & Message }
  // Electric will sync automatically via the shape subscription
  return {
    ...json.message,
    created_at: json.message.created_at
      ? new Date(json.message.created_at)
      : new Date(),
  }
}

async function deleteAllThreads() {
  const res = await fetch("/api/chat/mutations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "deleteAllThreads" }),
  })
  if (!res.ok) throw new Error("Failed to delete chats")
}

type Message = {
  id: number
  thread_id: number
  role: string
  content: string
  created_at: Date
}

const FREE_REQUEST_KEY = "gen_chat_free_requests"
const FREE_REQUEST_LIMIT = 1
const MODEL_STORAGE_KEY = "gen_chat_model"
const DARK_MODE_KEY = "gen_chat_dark_mode"

function getStoredDarkMode(): boolean {
  if (typeof window === "undefined") return false
  const stored = localStorage.getItem(DARK_MODE_KEY)
  if (stored !== null) return stored === "true"
  // Default to system preference
  return window.matchMedia("(prefers-color-scheme: dark)").matches
}

function setStoredDarkMode(dark: boolean) {
  localStorage.setItem(DARK_MODE_KEY, String(dark))
}

const AVAILABLE_MODELS = [
  { id: "google/gemini-2.0-flash-001", name: "Gemini 2.0 Flash", provider: "Google" },
  { id: "anthropic/claude-sonnet-4", name: "Claude Sonnet 4", provider: "Anthropic" },
  { id: "openai/gpt-4o", name: "GPT-4o", provider: "OpenAI" },
] as const

type ModelId = typeof AVAILABLE_MODELS[number]["id"]

function getStoredModel(): ModelId {
  if (typeof window === "undefined") return AVAILABLE_MODELS[0].id
  const stored = localStorage.getItem(MODEL_STORAGE_KEY)
  if (stored && AVAILABLE_MODELS.some(m => m.id === stored)) {
    return stored as ModelId
  }
  return AVAILABLE_MODELS[0].id
}

function setStoredModel(model: ModelId) {
  localStorage.setItem(MODEL_STORAGE_KEY, model)
}

function getFreeRequestCount(): number {
  if (typeof window === "undefined") return 0
  return parseInt(localStorage.getItem(FREE_REQUEST_KEY) || "0", 10)
}

function incrementFreeRequestCount(): number {
  const count = getFreeRequestCount() + 1
  localStorage.setItem(FREE_REQUEST_KEY, count.toString())
  return count
}

type GuestMessage = {
  id: number
  role: "user" | "assistant"
  content: string
}

// Shared UI props
type ChatUIProps = {
  darkMode: boolean
  toggleDarkMode: () => void
  selectedModel: ModelId
  handleModelChange: (model: ModelId) => void
}

// Authenticated chat with Electric sync
function AuthenticatedChat({
  session,
  darkMode,
  toggleDarkMode,
  selectedModel,
  handleModelChange,
}: ChatUIProps & { session: NonNullable<ReturnType<typeof authClient.useSession>["data"]> }) {
  const [activeThreadId, setActiveThreadId] = useState<number | null>(null)
  const [input, setInput] = useState("")
  const [isLoading, setIsLoading] = useState(false)
  const [streamingContent, setStreamingContent] = useState("")
  const [showProfileMenu, setShowProfileMenu] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const profileMenuRef = useRef<HTMLDivElement>(null)

  // Electric sync for authenticated users - collections are lazy-initialized
  const chatThreadsCollection = getChatThreadsCollection()
  const chatMessagesCollection = getChatMessagesCollection()

  const { data: threads = [] } = useLiveQuery((q) =>
    q
      .from({ chatThreads: chatThreadsCollection })
      .orderBy(({ chatThreads }) => chatThreads.created_at),
  )

  const sortedThreads = useMemo(
    () => [...threads].sort((a, b) => b.id - a.id),
    [threads],
  )

  useEffect(() => {
    if (activeThreadId === null && sortedThreads.length > 0) {
      setActiveThreadId(sortedThreads[0].id)
    }
  }, [sortedThreads, activeThreadId])

  const { data: dbMessages = [] } = useLiveQuery((q) => {
    const base = q
      .from({ chatMessages: chatMessagesCollection })
      .orderBy(({ chatMessages }) => chatMessages.created_at)
    if (activeThreadId) {
      return base.where(({ chatMessages }) =>
        eq(chatMessages.thread_id, activeThreadId),
      )
    }
    return base
  })

  const allMessages = useMemo(() => {
    const msgs = [...dbMessages]
    if (streamingContent) {
      msgs.push({
        id: -1,
        thread_id: activeThreadId ?? 0,
        role: "assistant",
        content: streamingContent,
        created_at: new Date(),
      })
    }
    return msgs
  }, [dbMessages, streamingContent, activeThreadId])

  // Auto-scroll to bottom when messages change
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" })
  }, [allMessages])

  // Close profile menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (
        profileMenuRef.current &&
        !profileMenuRef.current.contains(e.target as Node)
      ) {
        setShowProfileMenu(false)
      }
    }
    document.addEventListener("mousedown", handleClickOutside)
    return () => document.removeEventListener("mousedown", handleClickOutside)
  }, [])

  // Clear streaming content when switching threads
  useEffect(() => {
    setStreamingContent("")
  }, [activeThreadId])

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!input.trim() || isLoading) return

    const userMessage = input.trim()
    setInput("")
    setIsLoading(true)
    setStreamingContent("")

    try {
      let threadId = activeThreadId
      if (!threadId) {
        const thread = await createThread(
          userMessage.slice(0, 40) || "New chat",
        )
        threadId = thread.id
        setActiveThreadId(thread.id)
      }

      // Save user message to DB
      await addMessage({ threadId, role: "user", content: userMessage })

      // Get all messages for this thread to send to AI
      const messages = [
        ...dbMessages.map((m) => ({
          role: m.role as "user" | "assistant",
          content: m.content,
        })),
        { role: "user" as const, content: userMessage },
      ]

      // Call AI endpoint with streaming
      const res = await fetch("/api/chat/ai", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ threadId, messages, model: selectedModel }),
      })

      if (!res.ok) {
        throw new Error(`AI request failed: ${res.status}`)
      }

      // Handle streaming response
      const reader = res.body?.getReader()
      if (!reader) {
        throw new Error("No response body")
      }

      const decoder = new TextDecoder()
      let accumulated = ""

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        const chunk = decoder.decode(value, { stream: true })
        accumulated += chunk
        setStreamingContent(accumulated)
      }

      // Clear streaming content - Electric will sync new messages automatically
      setStreamingContent("")
    } catch (error) {
      console.error("Chat error:", error)
      setStreamingContent("")
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <div className={`min-h-screen grid grid-cols-1 md:grid-cols-[280px_1fr] ${darkMode ? "dark" : ""}`}>
      <aside className={`border-r flex flex-col h-screen ${darkMode ? "border-slate-700 bg-slate-900" : "border-slate-200 bg-white"}`}>
        <div className="p-4 flex justify-between items-center">
          <h2 className={`font-semibold ${darkMode ? "text-slate-100" : "text-slate-800"}`}>Chats</h2>
          <div className="flex items-center gap-2">
            <button
              onClick={toggleDarkMode}
              className={`p-1.5 rounded ${darkMode ? "text-yellow-400 hover:bg-slate-800" : "text-slate-500 hover:bg-slate-100"}`}
              title={darkMode ? "Light mode" : "Dark mode"}
            >
              {darkMode ? (
                <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M10 2a1 1 0 011 1v1a1 1 0 11-2 0V3a1 1 0 011-1zm4 8a4 4 0 11-8 0 4 4 0 018 0zm-.464 4.95l.707.707a1 1 0 001.414-1.414l-.707-.707a1 1 0 00-1.414 1.414zm2.12-10.607a1 1 0 010 1.414l-.706.707a1 1 0 11-1.414-1.414l.707-.707a1 1 0 011.414 0zM17 11a1 1 0 100-2h-1a1 1 0 100 2h1zm-7 4a1 1 0 011 1v1a1 1 0 11-2 0v-1a1 1 0 011-1zM5.05 6.464A1 1 0 106.465 5.05l-.708-.707a1 1 0 00-1.414 1.414l.707.707zm1.414 8.486l-.707.707a1 1 0 01-1.414-1.414l.707-.707a1 1 0 011.414 1.414zM4 11a1 1 0 100-2H3a1 1 0 000 2h1z" clipRule="evenodd" />
                </svg>
              ) : (
                <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                  <path d="M17.293 13.293A8 8 0 016.707 2.707a8.001 8.001 0 1010.586 10.586z" />
                </svg>
              )}
            </button>
            <button
              className={`text-sm px-2 py-1 rounded ${darkMode ? "bg-slate-100 text-slate-900" : "bg-slate-900 text-white"}`}
              onClick={async () => {
                const thread = await createThread()
                setActiveThreadId(thread.id)
              }}
            >
              New
            </button>
          </div>
        </div>
        <div className={`divide-y flex-1 overflow-y-auto ${darkMode ? "divide-slate-700" : "divide-slate-200"}`}>
          {sortedThreads.map((thread) => (
            <button
              key={thread.id}
              className={`w-full text-left px-4 py-3 ${
                darkMode
                  ? `hover:bg-slate-800 ${activeThreadId === thread.id ? "bg-slate-800" : ""}`
                  : `hover:bg-slate-100 ${activeThreadId === thread.id ? "bg-slate-100" : ""}`
              }`}
              onClick={() => setActiveThreadId(thread.id)}
            >
              <div className={`text-sm font-medium ${darkMode ? "text-slate-100" : "text-slate-800"}`}>
                {thread.title}
              </div>
              <div className={`text-xs ${darkMode ? "text-slate-400" : "text-slate-500"}`}>
                {new Date(thread.created_at).toLocaleString()}
              </div>
            </button>
          ))}
          {sortedThreads.length === 0 && (
            <div className={`px-4 py-3 text-sm ${darkMode ? "text-slate-400" : "text-slate-500"}`}>
              No chats yet. Create one to start talking to the AI.
            </div>
          )}
        </div>
        {sortedThreads.length > 0 && (
          <div className={`p-4 border-t ${darkMode ? "border-slate-700" : "border-slate-200"}`}>
            <button
              className={`w-full text-sm px-2 py-1 rounded border ${darkMode ? "border-red-400 text-red-400 hover:bg-red-900/20" : "border-red-300 text-red-600 hover:bg-red-50"}`}
              onClick={async () => {
                if (confirm("Delete all chats? This cannot be undone.")) {
                  await deleteAllThreads()
                  setActiveThreadId(null)
                }
              }}
            >
              Delete all chats
            </button>
          </div>
        )}
        <div className={`p-4 border-t ${darkMode ? "border-slate-700" : "border-slate-200"}`} ref={profileMenuRef}>
          <div className="relative">
            <button
              className={`flex items-center gap-2 w-full rounded p-2 -m-2 ${darkMode ? "hover:bg-slate-800" : "hover:bg-slate-100"}`}
              onClick={() => setShowProfileMenu(!showProfileMenu)}
            >
              <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium ${darkMode ? "bg-slate-100 text-slate-900" : "bg-slate-900 text-white"}`}>
                {session.user?.name?.[0]?.toUpperCase() ||
                  session.user?.email?.[0]?.toUpperCase() ||
                  "?"}
              </div>
              <div className="flex-1 text-left">
                <div className={`text-sm font-medium truncate ${darkMode ? "text-slate-100" : "text-slate-800"}`}>
                  {session.user?.name || session.user?.email}
                </div>
              </div>
            </button>
            {showProfileMenu && (
              <div className={`absolute bottom-full left-0 right-0 mb-2 rounded-lg shadow-lg py-1 ${darkMode ? "bg-slate-800 border border-slate-700" : "bg-white border border-slate-200"}`}>
                <button
                  className={`w-full text-left px-4 py-2 text-sm ${darkMode ? "text-slate-200 hover:bg-slate-700" : "text-slate-700 hover:bg-slate-100"}`}
                  onClick={async () => {
                    await authClient.signOut()
                    setShowProfileMenu(false)
                  }}
                >
                  Sign out
                </button>
              </div>
            )}
          </div>
        </div>
      </aside>
      <main className={`flex flex-col h-screen ${darkMode ? "bg-slate-950" : "bg-slate-50"}`}>
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {allMessages.map((msg) => (
            <div
              key={msg.id}
              className={`max-w-2xl rounded-lg px-4 py-3 ${
                msg.role === "assistant"
                  ? darkMode
                    ? "bg-slate-800 border border-slate-700 text-slate-100"
                    : "bg-white border border-slate-200"
                  : darkMode
                    ? "bg-slate-100 text-slate-900 ml-auto"
                    : "bg-slate-900 text-white ml-auto"
              }`}
            >
              <div className={`text-xs uppercase tracking-wide mb-1 ${darkMode ? "text-slate-400" : "text-slate-500"}`}>
                {msg.role}
              </div>
              <div className="whitespace-pre-wrap text-sm">{msg.content}</div>
            </div>
          ))}
          {allMessages.length === 0 && (
            <div className={`text-sm ${darkMode ? "text-slate-400" : "text-slate-500"}`}>
              No messages yet.
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>
        <form
          onSubmit={handleSend}
          className={`border-t p-4 ${darkMode ? "border-slate-700 bg-slate-900" : "border-slate-200 bg-white"}`}
        >
          <div className="flex items-center gap-2 mb-3">
            <span className={`text-xs ${darkMode ? "text-slate-400" : "text-slate-500"}`}>Model:</span>
            <select
              value={selectedModel}
              onChange={(e) => handleModelChange(e.target.value as ModelId)}
              className={`text-xs border rounded px-2 py-1 focus:outline-none focus:ring-1 ${
                darkMode
                  ? "border-slate-600 bg-slate-800 text-slate-200 focus:ring-slate-500"
                  : "border-slate-200 bg-white text-slate-700 focus:ring-slate-400"
              }`}
            >
              {AVAILABLE_MODELS.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.name}
                </option>
              ))}
            </select>
          </div>
          <div className="flex gap-3">
            <textarea
              className={`flex-1 border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 ${
                darkMode
                  ? "border-slate-600 bg-slate-800 text-slate-100 placeholder-slate-400 focus:ring-slate-500"
                  : "border-slate-300 bg-white text-slate-900 focus:ring-slate-900"
              }`}
              rows={3}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Ask the AI anything..."
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault()
                  handleSend(e)
                }
              }}
            />
            <button
              type="submit"
              className={`self-end px-4 py-2 rounded-lg disabled:opacity-50 ${
                darkMode ? "bg-slate-100 text-slate-900" : "bg-slate-900 text-white"
              }`}
              disabled={isLoading}
            >
              {isLoading ? "Sending..." : "Send"}
            </button>
          </div>
        </form>
      </main>
    </div>
  )
}

// Guest chat without Electric sync
function GuestChat({
  darkMode,
  toggleDarkMode,
  selectedModel,
  handleModelChange,
}: ChatUIProps) {
  const [input, setInput] = useState("")
  const [isLoading, setIsLoading] = useState(false)
  const [streamingContent, setStreamingContent] = useState("")
  const [guestMessages, setGuestMessages] = useState<GuestMessage[]>([])
  const [freeRequestsUsed, setFreeRequestsUsed] = useState(0)
  const [showAuthPrompt, setShowAuthPrompt] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setFreeRequestsUsed(getFreeRequestCount())
  }, [])

  const allMessages = useMemo(() => {
    const msgs = guestMessages.map((m) => ({
      id: m.id,
      thread_id: 0,
      role: m.role,
      content: m.content,
      created_at: new Date(),
    }))
    if (streamingContent) {
      msgs.push({
        id: -1,
        thread_id: 0,
        role: "assistant",
        content: streamingContent,
        created_at: new Date(),
      })
    }
    return msgs
  }, [guestMessages, streamingContent])

  // Auto-scroll to bottom when messages change
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" })
  }, [allMessages])

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!input.trim() || isLoading) return

    const userMessage = input.trim()
    setInput("")
    setIsLoading(true)
    setStreamingContent("")

    // Check if guest has used their free request
    if (freeRequestsUsed >= FREE_REQUEST_LIMIT) {
      setShowAuthPrompt(true)
      setIsLoading(false)
      return
    }

    try {
      const newUserMsg: GuestMessage = {
        id: Date.now(),
        role: "user",
        content: userMessage,
      }
      setGuestMessages((prev) => [...prev, newUserMsg])

      // Call guest AI endpoint
      const messages = [
        ...guestMessages.map((m) => ({ role: m.role, content: m.content })),
        { role: "user" as const, content: userMessage },
      ]

      const res = await fetch("/api/chat/guest", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages, model: selectedModel }),
      })

      if (!res.ok) {
        throw new Error(`AI request failed: ${res.status}`)
      }

      const reader = res.body?.getReader()
      if (!reader) {
        throw new Error("No response body")
      }

      const decoder = new TextDecoder()
      let accumulated = ""

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        const chunk = decoder.decode(value, { stream: true })
        accumulated += chunk
        setStreamingContent(accumulated)
      }

      // Add assistant message to guest messages
      const newAssistantMsg: GuestMessage = {
        id: Date.now() + 1,
        role: "assistant",
        content: accumulated,
      }
      setGuestMessages((prev) => [...prev, newAssistantMsg])
      setStreamingContent("")

      // Increment free request counter and show auth prompt
      const newCount = incrementFreeRequestCount()
      setFreeRequestsUsed(newCount)
      if (newCount >= FREE_REQUEST_LIMIT) {
        setShowAuthPrompt(true)
      }
    } catch (error) {
      console.error("Chat error:", error)
      setStreamingContent("")
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <>
      <div className={`min-h-screen grid grid-cols-1 md:grid-cols-[280px_1fr] ${darkMode ? "dark" : ""}`}>
        <aside className={`border-r flex flex-col h-screen ${darkMode ? "border-slate-700 bg-slate-900" : "border-slate-200 bg-white"}`}>
          <div className="p-4 flex justify-between items-center">
            <h2 className={`font-semibold ${darkMode ? "text-slate-100" : "text-slate-800"}`}>Chats</h2>
            <div className="flex items-center gap-2">
              <button
                onClick={toggleDarkMode}
                className={`p-1.5 rounded ${darkMode ? "text-yellow-400 hover:bg-slate-800" : "text-slate-500 hover:bg-slate-100"}`}
                title={darkMode ? "Light mode" : "Dark mode"}
              >
                {darkMode ? (
                  <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                    <path fillRule="evenodd" d="M10 2a1 1 0 011 1v1a1 1 0 11-2 0V3a1 1 0 011-1zm4 8a4 4 0 11-8 0 4 4 0 018 0zm-.464 4.95l.707.707a1 1 0 001.414-1.414l-.707-.707a1 1 0 00-1.414 1.414zm2.12-10.607a1 1 0 010 1.414l-.706.707a1 1 0 11-1.414-1.414l.707-.707a1 1 0 011.414 0zM17 11a1 1 0 100-2h-1a1 1 0 100 2h1zm-7 4a1 1 0 011 1v1a1 1 0 11-2 0v-1a1 1 0 011-1zM5.05 6.464A1 1 0 106.465 5.05l-.708-.707a1 1 0 00-1.414 1.414l.707.707zm1.414 8.486l-.707.707a1 1 0 01-1.414-1.414l.707-.707a1 1 0 011.414 1.414zM4 11a1 1 0 100-2H3a1 1 0 000 2h1z" clipRule="evenodd" />
                  </svg>
                ) : (
                  <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                    <path d="M17.293 13.293A8 8 0 016.707 2.707a8.001 8.001 0 1010.586 10.586z" />
                  </svg>
                )}
              </button>
            </div>
          </div>
          <div className={`divide-y flex-1 overflow-y-auto ${darkMode ? "divide-slate-700" : "divide-slate-200"}`}>
            <div className={`px-4 py-3 text-sm ${darkMode ? "text-slate-400" : "text-slate-500"}`}>
              {freeRequestsUsed < FREE_REQUEST_LIMIT
                ? `Try 1 free message! (${FREE_REQUEST_LIMIT - freeRequestsUsed} remaining)`
                : "Sign in to continue chatting."}
            </div>
          </div>
          <div className={`p-4 border-t ${darkMode ? "border-slate-700" : "border-slate-200"}`}>
            <a
              href="/login"
              className={`block w-full text-center text-sm px-4 py-2 rounded ${darkMode ? "bg-slate-100 text-slate-900 hover:bg-slate-200" : "bg-slate-900 text-white hover:bg-slate-800"}`}
            >
              Login
            </a>
          </div>
        </aside>
        <main className={`flex flex-col h-screen ${darkMode ? "bg-slate-950" : "bg-slate-50"}`}>
          <div className="flex-1 overflow-y-auto p-4 space-y-3">
            {allMessages.map((msg) => (
              <div
                key={msg.id}
                className={`max-w-2xl rounded-lg px-4 py-3 ${
                  msg.role === "assistant"
                    ? darkMode
                      ? "bg-slate-800 border border-slate-700 text-slate-100"
                      : "bg-white border border-slate-200"
                    : darkMode
                      ? "bg-slate-100 text-slate-900 ml-auto"
                      : "bg-slate-900 text-white ml-auto"
                }`}
              >
                <div className={`text-xs uppercase tracking-wide mb-1 ${darkMode ? "text-slate-400" : "text-slate-500"}`}>
                  {msg.role}
                </div>
                <div className="whitespace-pre-wrap text-sm">{msg.content}</div>
              </div>
            ))}
            {allMessages.length === 0 && (
              <div className={`text-sm ${darkMode ? "text-slate-400" : "text-slate-500"}`}>
                Try a free message! Ask the AI anything.
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>
          <form
            onSubmit={handleSend}
            className={`border-t p-4 ${darkMode ? "border-slate-700 bg-slate-900" : "border-slate-200 bg-white"}`}
          >
            <div className="flex items-center gap-2 mb-3">
              <span className={`text-xs ${darkMode ? "text-slate-400" : "text-slate-500"}`}>Model:</span>
              <select
                value={selectedModel}
                onChange={(e) => handleModelChange(e.target.value as ModelId)}
                className={`text-xs border rounded px-2 py-1 focus:outline-none focus:ring-1 ${
                  darkMode
                    ? "border-slate-600 bg-slate-800 text-slate-200 focus:ring-slate-500"
                    : "border-slate-200 bg-white text-slate-700 focus:ring-slate-400"
                }`}
              >
                {AVAILABLE_MODELS.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex gap-3">
              <textarea
                className={`flex-1 border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 ${
                  darkMode
                    ? "border-slate-600 bg-slate-800 text-slate-100 placeholder-slate-400 focus:ring-slate-500"
                    : "border-slate-300 bg-white text-slate-900 focus:ring-slate-900"
                }`}
                rows={3}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="Try a free message..."
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault()
                    handleSend(e)
                  }
                }}
              />
              <button
                type="submit"
                className={`self-end px-4 py-2 rounded-lg disabled:opacity-50 ${
                  darkMode ? "bg-slate-100 text-slate-900" : "bg-slate-900 text-white"
                }`}
                disabled={isLoading}
              >
                {isLoading ? "Sending..." : "Send"}
              </button>
            </div>
          </form>
        </main>
      </div>

      {/* Auth prompt modal */}
      {showAuthPrompt && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className={`rounded-xl p-6 max-w-md mx-4 shadow-xl ${darkMode ? "bg-slate-800" : "bg-white"}`}>
            <h2 className={`text-xl font-semibold mb-2 ${darkMode ? "text-slate-100" : "text-slate-800"}`}>
              Sign in to continue
            </h2>
            <p className={`mb-4 ${darkMode ? "text-slate-300" : "text-slate-600"}`}>
              You've used your free message. Sign in to get unlimited access and
              save your chat history.
            </p>
            <div className="flex gap-3">
              <button
                className={`flex-1 px-4 py-2 border rounded-lg ${
                  darkMode
                    ? "border-slate-600 text-slate-200 hover:bg-slate-700"
                    : "border-slate-300 text-slate-700 hover:bg-slate-50"
                }`}
                onClick={() => setShowAuthPrompt(false)}
              >
                Maybe later
              </button>
              <a
                href="/login"
                className={`flex-1 px-4 py-2 rounded-lg text-center ${
                  darkMode
                    ? "bg-slate-100 text-slate-900 hover:bg-slate-200"
                    : "bg-slate-900 text-white hover:bg-slate-800"
                }`}
              >
                Sign in
              </a>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

// Main ChatPage component that switches between authenticated and guest views
export function ChatPage() {
  const { data: session, isPending } = authClient.useSession()
  const [selectedModel, setSelectedModel] = useState<ModelId>(AVAILABLE_MODELS[0].id)
  const [darkMode, setDarkMode] = useState(false)

  // Initialize model and dark mode from localStorage
  useEffect(() => {
    setSelectedModel(getStoredModel())
    setDarkMode(getStoredDarkMode())
  }, [])

  const handleModelChange = (model: ModelId) => {
    setSelectedModel(model)
    setStoredModel(model)
  }

  const toggleDarkMode = () => {
    const newValue = !darkMode
    setDarkMode(newValue)
    setStoredDarkMode(newValue)
  }

  // Show loading state
  if (isPending) {
    return null
  }

  const isAuthenticated = !!session?.session

  if (isAuthenticated) {
    return (
      <AuthenticatedChat
        session={session}
        darkMode={darkMode}
        toggleDarkMode={toggleDarkMode}
        selectedModel={selectedModel}
        handleModelChange={handleModelChange}
      />
    )
  }

  return (
    <GuestChat
      darkMode={darkMode}
      toggleDarkMode={toggleDarkMode}
      selectedModel={selectedModel}
      handleModelChange={handleModelChange}
    />
  )
}
