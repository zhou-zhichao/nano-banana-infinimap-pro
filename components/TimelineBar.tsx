"use client";

type TimelineNodeItem = {
  index: number;
  id: string;
  createdAt: string;
};

type TimelineBarProps = {
  nodes: TimelineNodeItem[];
  activeIndex: number;
  minNodes: number;
  loading?: boolean;
  onSelect: (index: number) => void;
  onAddAfterActive: () => void;
  onDeleteActive: () => void;
};

export default function TimelineBar({
  nodes,
  activeIndex,
  minNodes,
  loading = false,
  onSelect,
  onAddAfterActive,
  onDeleteActive,
}: TimelineBarProps) {
  return (
    <div className="absolute bottom-3 left-1/2 -translate-x-1/2 z-[1500] w-[min(96vw,980px)] pointer-events-none">
      <div className="pointer-events-auto rounded-2xl border border-gray-200 bg-white/95 shadow-xl backdrop-blur px-3 py-2">
        <div className="flex items-center gap-2 mb-2">
          <div className="text-xs font-medium text-gray-700">Timeline</div>
          <div className="text-[11px] text-gray-500">Node {activeIndex}/{nodes.length}</div>
          <button
            type="button"
            onClick={onAddAfterActive}
            disabled={loading}
            className="ml-auto h-7 px-2 rounded-md border border-emerald-300 text-emerald-700 bg-emerald-50 hover:bg-emerald-100 disabled:opacity-50 text-xs"
            title="Insert node after current node"
          >
            + Node
          </button>
          <button
            type="button"
            onClick={onDeleteActive}
            disabled={loading || nodes.length <= minNodes}
            className="h-7 px-2 rounded-md border border-rose-300 text-rose-700 bg-rose-50 hover:bg-rose-100 disabled:opacity-50 text-xs"
            title="Delete current node"
          >
            Delete
          </button>
        </div>

        <div className="overflow-x-auto">
          <div className="relative min-w-max px-2 py-1">
            <div className="absolute left-0 right-0 top-1/2 -translate-y-1/2 h-[2px] bg-gray-200" />
            <div className="relative flex items-center gap-3">
              {nodes.map((node) => {
                const active = node.index === activeIndex;
                return (
                  <button
                    key={node.id}
                    type="button"
                    onClick={() => onSelect(node.index)}
                    disabled={loading}
                    className={`relative h-6 w-6 rounded-full border text-[10px] font-semibold transition ${
                      active
                        ? "bg-blue-600 border-blue-700 text-white shadow"
                        : "bg-white border-gray-300 text-gray-600 hover:bg-gray-50"
                    } disabled:opacity-50`}
                    title={`Jump to node ${node.index}`}
                  >
                    {node.index}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

