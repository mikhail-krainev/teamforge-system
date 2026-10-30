import Image from 'next/image';
import fxScene from './scene/hero-scene-fx.svg';
import scene from './scene/hero-scene.svg';
import './HeroScene.css';

/** Evening ski resort behind the hero: static painting plus a light animated layer on top. */
export function HeroScene() {
  return (
    <div className="hero-scene" aria-hidden="true">
      <Image className="hero-scene-img" src={scene} alt="" fill priority unoptimized sizes="100vw" />
      <Image className="hero-scene-img" src={fxScene} alt="" fill unoptimized sizes="100vw" />
    </div>
  );
}
