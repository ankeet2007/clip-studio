// Example mockup component — duplicate or rename this file to create new previews.
// The sandbox auto-discovers any .tsx file in this directory at dev/build time.
export default function ExampleCard() {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        minHeight: "100vh",
        background: "#f9fafb",
        fontFamily: "system-ui, sans-serif",
      }}
    >
      <div
        style={{
          background: "#fff",
          borderRadius: 12,
          boxShadow: "0 2px 16px rgba(0,0,0,0.08)",
          padding: "2rem 2.5rem",
          maxWidth: 360,
          width: "100%",
          textAlign: "center",
        }}
      >
        <div style={{ fontSize: 40, marginBottom: 12 }}>🎬</div>
        <h2 style={{ margin: "0 0 8px", fontSize: 20, fontWeight: 700, color: "#111" }}>
          ExampleCard
        </h2>
        <p style={{ margin: 0, color: "#6b7280", fontSize: 14, lineHeight: 1.6 }}>
          This is a placeholder mockup. Edit{" "}
          <code
            style={{
              background: "#f3f4f6",
              padding: "1px 6px",
              borderRadius: 4,
              fontSize: 13,
            }}
          >
            src/components/mockups/ExampleCard.tsx
          </code>{" "}
          or add new files alongside it to create more previews.
        </p>
      </div>
    </div>
  );
}
