import { useEffect, useRef } from "react";

const BAR_HEIGHTS = [13, 22, 33, 44, 49, 44, 33, 22, 13];

export function Waveform({ analyser }: { analyser: AnalyserNode | undefined }) {
  const waveform = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!analyser || !waveform.current) return;
    const bars = Array.from(waveform.current.children) as HTMLElement[];
    const samples = new Float32Array(analyser.fftSize);
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let frame = 0;

    function draw() {
      analyser?.getFloatTimeDomainData(samples);
      bars.forEach((bar, index) => {
        const start = Math.floor(index * samples.length / bars.length);
        const end = Math.floor((index + 1) * samples.length / bars.length);
        let power = 0;
        for (let sample = start; sample < end; sample += 1) {
          power += samples[sample] ** 2;
        }
        const volume = Math.sqrt(power / (end - start));
        const height = Math.min(1, 0.15 + Math.max(0, volume - 0.006) * 4);
        bar.style.transform = `scaleY(${height})`;
      });
      frame = window.requestAnimationFrame(draw);
    }

    function updateMotion() {
      window.cancelAnimationFrame(frame);
      if (reducedMotion.matches) {
        bars.forEach((bar) => bar.style.removeProperty("transform"));
      } else {
        frame = window.requestAnimationFrame(draw);
      }
    }

    updateMotion();
    reducedMotion.addEventListener("change", updateMotion);
    return () => {
      window.cancelAnimationFrame(frame);
      reducedMotion.removeEventListener("change", updateMotion);
    };
  }, [analyser]);

  return (
    <span className="waveform" ref={waveform} aria-hidden="true">
      {BAR_HEIGHTS.map((height, index) => <span key={index} style={{ height }} />)}
    </span>
  );
}
