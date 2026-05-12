import { useEffect, useRef } from "react";

interface Node { x: number; y: number; r: number; delay: number }
interface Edge { a: number; b: number }

export default function HeroGraph() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const W = canvas.offsetWidth;
    const H = canvas.offsetHeight;
    canvas.width = W;
    canvas.height = H;

    const nodes: Node[] = [
      { x: W * 0.5, y: H * 0.12, r: 7, delay: 0 },        // root cause
      { x: W * 0.28, y: H * 0.38, r: 5, delay: 0.4 },
      { x: W * 0.72, y: H * 0.38, r: 5, delay: 0.6 },
      { x: W * 0.14, y: H * 0.65, r: 4, delay: 0.8 },
      { x: W * 0.42, y: H * 0.65, r: 4, delay: 1.0 },
      { x: W * 0.58, y: H * 0.65, r: 4, delay: 1.2 },
      { x: W * 0.86, y: H * 0.65, r: 4, delay: 1.4 },
      { x: W * 0.25, y: H * 0.88, r: 3, delay: 1.6 },
      { x: W * 0.5,  y: H * 0.88, r: 3, delay: 1.8 },
      { x: W * 0.75, y: H * 0.88, r: 3, delay: 2.0 },
    ];
    const edges: Edge[] = [
      { a: 0, b: 1 }, { a: 0, b: 2 },
      { a: 1, b: 3 }, { a: 1, b: 4 },
      { a: 2, b: 5 }, { a: 2, b: 6 },
      { a: 3, b: 7 }, { a: 4, b: 7 }, { a: 4, b: 8 },
      { a: 5, b: 8 }, { a: 5, b: 9 }, { a: 6, b: 9 },
    ];

    let frame = 0;
    let raf: number;

    const draw = () => {
      ctx.clearRect(0, 0, W, H);
      const t = frame / 60;

      // Draw edges
      edges.forEach(({ a, b }) => {
        const na = nodes[a];
        const nb = nodes[b];
        const alpha = 0.15 + 0.1 * Math.sin(t * 0.8 + na.delay);
        ctx.beginPath();
        ctx.moveTo(na.x, na.y);
        ctx.lineTo(nb.x, nb.y);
        ctx.strokeStyle = `rgba(45,212,191,${alpha})`;
        ctx.lineWidth = 1;
        ctx.stroke();
      });

      // Draw nodes
      nodes.forEach(node => {
        const pulse = 0.5 + 0.5 * Math.sin(t * 1.2 + node.delay);
        const r = node.r + pulse * 2;
        const alpha = 0.4 + 0.6 * pulse;

        // Glow
        const grad = ctx.createRadialGradient(node.x, node.y, 0, node.x, node.y, r * 3);
        grad.addColorStop(0, `rgba(45,212,191,${alpha * 0.4})`);
        grad.addColorStop(1, "rgba(45,212,191,0)");
        ctx.beginPath();
        ctx.arc(node.x, node.y, r * 3, 0, Math.PI * 2);
        ctx.fillStyle = grad;
        ctx.fill();

        // Core
        ctx.beginPath();
        ctx.arc(node.x, node.y, r, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(45,212,191,${alpha})`;
        ctx.fill();
      });

      frame++;
      raf = requestAnimationFrame(draw);
    };

    draw();
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className="w-full h-full opacity-70"
      style={{ display: "block" }}
    />
  );
}
