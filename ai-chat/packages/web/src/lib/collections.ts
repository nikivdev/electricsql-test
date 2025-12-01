import { createCollection } from "@tanstack/react-db"
import { electricCollectionOptions } from "@tanstack/electric-db-collection"
import {
  selectUsersSchema,
  selectChatThreadSchema,
  selectChatMessageSchema,
} from "@/db/schema"

export const usersCollection = createCollection(
  electricCollectionOptions({
    id: "users",
    shapeOptions: {
      url: new URL(
        "/api/users",
        typeof window !== "undefined"
          ? window.location.origin
          : "http://localhost:3000",
      ).toString(),
      parser: {
        timestamptz: (date: string) => new Date(date),
      },
    },
    schema: selectUsersSchema,
    getKey: (item) => item.id,
  }),
)

const baseUrl =
  typeof window !== "undefined"
    ? window.location.origin
    : "http://localhost:3000"

// Lazy-initialized collections to avoid fetching before authentication
let _chatThreadsCollection: ReturnType<typeof createCollection> | null = null
let _chatMessagesCollection: ReturnType<typeof createCollection> | null = null

export function getChatThreadsCollection() {
  if (!_chatThreadsCollection) {
    _chatThreadsCollection = createCollection(
      electricCollectionOptions({
        id: "chat_threads",
        shapeOptions: {
          url: new URL("/api/chat-threads", baseUrl).toString(),
          parser: {
            timestamptz: (date: string) => new Date(date),
          },
          fetchClient: (input, init) =>
            fetch(input, { ...init, credentials: "include" }),
        },
        schema: selectChatThreadSchema,
        getKey: (item) => item.id,
      }),
    )
  }
  return _chatThreadsCollection
}

export function getChatMessagesCollection() {
  if (!_chatMessagesCollection) {
    _chatMessagesCollection = createCollection(
      electricCollectionOptions({
        id: "chat_messages",
        shapeOptions: {
          url: new URL("/api/chat-messages", baseUrl).toString(),
          parser: {
            timestamptz: (date: string) => new Date(date),
          },
          fetchClient: (input, init) =>
            fetch(input, { ...init, credentials: "include" }),
        },
        schema: selectChatMessageSchema,
        getKey: (item) => item.id,
      }),
    )
  }
  return _chatMessagesCollection
}

// Keep exports for backward compatibility but as getters
export const chatThreadsCollection = {
  get collection() {
    return getChatThreadsCollection()
  },
}

export const chatMessagesCollection = {
  get collection() {
    return getChatMessagesCollection()
  },
}
