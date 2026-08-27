"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Conversation,
  listConversations,
  deleteConversation,
} from "@/lib/storage";
import { MessageSquare, Plus, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";

export function ConversationSidebar({
  activeId,
  onSelect,
  onNew,
  onClose,
}: {
  activeId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onClose: () => void;
}) {
  const [conversations, setConversations] = useState<Conversation[]>(() =>
    listConversations()
  );
  const [showSummary, setShowSummary] = useState(false);

  function refresh() {
    setConversations(listConversations());
  }

  function handleDelete(id: string, e: React.MouseEvent) {
    e.stopPropagation();
    deleteConversation(id);
    const updated = listConversations();
    setConversations(updated);
    if (id === activeId) onNew();
  }

  function handleNew() {
    onNew();
    setShowSummary(false);
    setTimeout(() => setConversations(listConversations()), 0);
  }


  return (
    <div className="flex h-full w-64 flex-col border-r bg-background">
      <div className="flex items-center justify-between p-3 pt-4 border-b">
        <span className="text-sm font-medium">Chats</span>
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={handleNew} aria-label="New chat">
          <Plus className="size-4" />
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto p-2">
        {conversations.length === 0 ? (
          <p className="text-xs text-muted-foreground text-center py-4">
            No conversations yet
          </p>
        ) : (
          <div className="flex flex-col gap-1">
            {conversations.map((conv) => (
              <button
                key={conv.id}
                onClick={() => { onSelect(conv.id); setShowSummary(false); }}
                className={cn(
                  "group flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm w-full hover:bg-muted transition-colors",
                  activeId === conv.id && "bg-muted"
                )}
              >
                <MessageSquare className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate flex-1">{conv.title}</span>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 opacity-0 group-hover:opacity-100 shrink-0"
                  onClick={(e) => handleDelete(conv.id, e)}
                  aria-label="Delete conversation"
                >
                  <Trash2 className="size-3 text-muted-foreground" />
                </Button>
              </button>
            ))}
          </div>
        )}
      </div>

    </div>
  );
}
