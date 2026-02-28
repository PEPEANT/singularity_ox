export function disposeMeshTree(root) {
  if (!root) {
    return;
  }

  root.traverse((node) => {
    if (node.geometry) {
      node.geometry.dispose?.();
    }

    const material = node.material;
    if (Array.isArray(material)) {
      for (const item of material) {
        item?.dispose?.();
      }
      return;
    }

    material?.dispose?.();
  });
}