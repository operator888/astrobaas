/**
 * A minimal React Three Fiber island: a slowly rotating icosahedron. Rendered
 * as an Astro island (`client:visible`) so the Three.js/R3F bundle only loads
 * when the canvas scrolls into view — the rest of the page stays zero-JS.
 *
 * The mesh colour is passed from the page (which reads it from the CMS theme),
 * demonstrating CMS data → animated frontend. Respects prefers-reduced-motion.
 */
import { useRef, useState, useEffect } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import type { Mesh } from 'three';

function Shape({ color, animate }: { color: string; animate: boolean }) {
  const ref = useRef<Mesh>(null);
  useFrame((_, delta) => {
    if (animate && ref.current) {
      ref.current.rotation.x += delta * 0.3;
      ref.current.rotation.y += delta * 0.45;
    }
  });
  return (
    <mesh ref={ref}>
      <icosahedronGeometry args={[1.4, 0]} />
      <meshStandardMaterial color={color} flatShading metalness={0.1} roughness={0.4} />
    </mesh>
  );
}

export default function Spinner3D({ color = '#3B82F6' }: { color?: string }) {
  const [animate, setAnimate] = useState(true);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setAnimate(!mq.matches);
    const on = () => setAnimate(!mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);

  return (
    <Canvas camera={{ position: [0, 0, 4] }} style={{ width: '100%', height: '100%' }} dpr={[1, 2]}>
      <ambientLight intensity={0.6} />
      <directionalLight position={[3, 3, 3]} intensity={1.1} />
      <Shape color={color} animate={animate} />
    </Canvas>
  );
}
