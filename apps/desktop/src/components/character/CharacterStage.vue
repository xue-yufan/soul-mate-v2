<template>
    <div ref="containerRef" class="character-stage">
        <p v-if="note" class="stage-note" :data-tone="state">{{ note }}</p>
    </div>
</template>

<script setup lang="ts">
import { VRMLoaderPlugin, VRMUtils, type VRM } from "@pixiv/three-vrm";
import {
    AmbientLight,
    Box3,
    Timer,
    DirectionalLight,
    HemisphereLight,
    MathUtils,
    Material,
    Mesh,
    MeshBasicMaterial,
    MeshStandardMaterial,
    NeutralToneMapping,
    PMREMGenerator,
    PerspectiveCamera,
    Raycaster,
    Scene,
    SphereGeometry,
    SRGBColorSpace,
    Vector2,
    Vector3,
    WebGLRenderer,
    type Object3D,
    type Texture,
} from "three";
import { GLTFLoader, type GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { onBeforeUnmount, onMounted, ref } from "vue";

import type { MouthSignal } from "@/composables/useTts";
import type { Emotion } from "@/types/protocol";
import type { CharacterInteraction, CharacterInteractionPart } from "./interactions";

/**
 * 模型放 public/model/character/ 下，用相对路径引用。
 * 渲染层的 base 是 "./"，写死 "/model/..." 在打包后会指到盘符根目录。
 */
const MODEL_URL = "model/character/xiadie.vrm";

/** 取景留白：1.0 刚好贴边，越大离角色越远 */
const FIT_MARGIN = 1.16;

/** 表情过渡阻尼，越大切得越快（8 大约 0.4 秒到位） */
const EXPRESSION_DAMPING = 8;

/** 眨眼的闭合时长（秒），以及两次之间的随机间隔范围 */
const BLINK_DURATION = 0.18;
const BLINK_GAP_MIN = 2.2;
const BLINK_GAP_MAX = 5.6;

/**
 * 后端 7 种 emotion → VRM 表情名。
 *
 * 名字都是导出文件里查过的真实名字：happy / sad / surprised / angry 是 VRM 预设，
 * shy(はぅ) / troubled(困った) 是自定义表情。
 * 计划文档里那套「shy 用 happy×0.5 + relaxed×0.3 凑」是模型还没有自定义表情时的旧方案，
 * 现在有真表情了，直接一对一。
 */
const EMOTION_EXPRESSIONS: Record<Emotion, Record<string, number>> = {
    neutral: {},
    happy: { happy: 1 },
    sad: { sad: 1 },
    surprised: { surprised: 1 },
    shy: { shy: 1 },
    thinking: { troubled: 0.9 },
    angry: { angry: 1 },
};

/**
 * 每帧都要写一遍的表情。
 * 只列可能出场的名字，模型里没有的会被 getExpression 跳过（导出的模型里 tears 也在，
 * 想给 sad 加强度的话在 EMOTION_EXPRESSIONS 里加 { tears: 0.4 } 就行）。
 */
const DRIVEN_EXPRESSIONS = [
    "happy",
    "sad",
    "surprised",
    "angry",
    "shy",
    "troubled",
    "tears",
    "aa",
    "ih",
    "ou",
    "ee",
    "oh",
];

/** 说话时轮换的元音，假口型用；接上音频包络后这个表就退化成播放源 */
const MOUTH_VOWELS = ["aa", "ih", "ou", "ee"];

const props = defineProps<{
    emotion: Emotion;
    speaking: boolean;
    /** TTS 实时算出来的张嘴包络；没传时退化成正弦假口型 */
    mouth?: MouthSignal;
}>();

const emit = defineEmits<{
    ready: [];
    failed: [reason: string];
    interact: [interaction: CharacterInteraction];
}>();

const containerRef = ref<HTMLDivElement | null>(null);
const state = ref<"loading" | "ready" | "failed">("loading");
const note = ref("3D 模型载入中…");

// three 的对象不放 ref：它们是长生命周期的可变对象，进响应式系统只会平白多一层 proxy
let renderer: WebGLRenderer | null = null;
let scene: Scene | null = null;
let camera: PerspectiveCamera | null = null;
let vrm: VRM | null = null;
let modelBounds: Box3 | null = null;
let environmentMap: Texture | null = null;
let resizeObserver: ResizeObserver | null = null;
let frameId = 0;
const timer = new Timer();
const raycaster = new Raycaster();
const pointerNdc = new Vector2();
const hitWorldPosition = new Vector3();

interface HitProxy {
    part: Exclude<CharacterInteractionPart, "none">;
    mesh: Mesh;
    bone: Object3D;
}

let hitProxies: HitProxy[] = [];
let pointerStart: {
    x: number;
    y: number;
    at: number;
    rotationY: number;
} | null = null;
let dragging = false;
let clickTimer: number | null = null;

let blinkStartedAt = -1;
let nextBlinkAt = BLINK_GAP_MIN;

function describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function fail(reason: string): void {
    state.value = "failed";
    note.value = "3D 模型没起来，先用立绘顶着";
    console.warn("[角色] 3D 舞台不可用：", reason);
    emit("failed", reason);
}

function fitCamera(): void {
    if (!camera || !modelBounds) {
        return;
    }

    const size = new Vector3();
    const center = new Vector3();
    modelBounds.getSize(size);
    modelBounds.getCenter(center);

    const halfFov = MathUtils.degToRad(camera.fov) / 2;
    const distanceForHeight = (size.y * FIT_MARGIN) / 2 / Math.tan(halfFov);
    const distanceForWidth = (size.x * FIT_MARGIN) / 2 / (Math.tan(halfFov) * camera.aspect);
    const distance = Math.max(distanceForHeight, distanceForWidth);

    // 相机放在 +Z：Blender 里模型朝 -Y，转成 glTF 的 Y-up 之后就是朝 +Z，正对着是脸
    camera.position.set(center.x, center.y, center.z + distance);
    camera.lookAt(center.x, center.y, center.z);
}

function applySize(): void {
    const container = containerRef.value;
    if (!container || !renderer || !camera) {
        return;
    }

    const width = Math.max(1, container.clientWidth);
    const height = Math.max(1, container.clientHeight);

    // 这台机器只有软件渲染，像素比拉太高会直接卡住
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    fitCamera();
}

/** 眨眼：three-vrm 不自动眨眼，得自己给 blink 打拍子 */
function blinkWeight(elapsed: number): number {
    if (blinkStartedAt < 0) {
        if (elapsed >= nextBlinkAt) {
            blinkStartedAt = elapsed;
        }
        return 0;
    }

    const progress = (elapsed - blinkStartedAt) / BLINK_DURATION;
    if (progress >= 1) {
        blinkStartedAt = -1;
        nextBlinkAt = elapsed + BLINK_GAP_MIN + Math.random() * (BLINK_GAP_MAX - BLINK_GAP_MIN);
        return 0;
    }

    return progress < 0.5 ? progress * 2 : (1 - progress) * 2;
}

/**
 * 口型：张嘴程度优先取 useTts 写的音频包络（0~1），没传就退化成正弦。
 * 元音每 0.4 秒轮换一次，只为了让嘴形不是单纯地开合。
 */
function mouthTargets(elapsed: number, speaking: boolean): Record<string, number> {
    if (!speaking) {
        return {};
    }

    const open = props.mouth
        ? MathUtils.clamp(props.mouth.open, 0, 1)
        : 0.18 + 0.42 * Math.abs(Math.sin(elapsed * 8.5));
    if (open <= 0.01) {
        return {};
    }

    const targets: Record<string, number> = { aa: open };
    const secondary = MOUTH_VOWELS[Math.floor(elapsed * 2.6) % MOUTH_VOWELS.length];
    if (secondary !== "aa") {
        targets[secondary] = open * 0.5;
    }
    return targets;
}

function updateExpressions(delta: number, elapsed: number): void {
    const manager = vrm?.expressionManager;
    if (!manager) {
        return;
    }

    const targets: Record<string, number> = {
        ...EMOTION_EXPRESSIONS[props.emotion],
        ...mouthTargets(elapsed, props.speaking),
    };

    for (const name of DRIVEN_EXPRESSIONS) {
        if (!manager.getExpression(name)) {
            continue;
        }
        const current = manager.getValue(name) ?? 0;
        const target = MathUtils.clamp(targets[name] ?? 0, 0, 1);
        manager.setValue(name, MathUtils.damp(current, target, EXPRESSION_DAMPING, delta));
    }

    // 眨眼不参与阻尼：闭合全程只有 0.18 秒，阻尼会把峰值削掉，眼睛就永远闭不上
    manager.setValue("blink", blinkWeight(elapsed));
}

function createHitProxies(): void {
    if (!vrm || !modelBounds) {
        return;
    }

    disposeHitProxies();
    const height = modelBounds.getSize(new Vector3()).y;
    const sphere = new SphereGeometry(1, 10, 8);
    const material = new MeshBasicMaterial({
        transparent: true,
        opacity: 0,
        depthWrite: false,
    });

    const specs: Array<{
        part: Exclude<CharacterInteractionPart, "none">;
        bone: Object3D | null;
        radius: number;
    }> = [
        {
            part: "head",
            bone: vrm.humanoid.getNormalizedBoneNode("head"),
            radius: height * 0.15,
        },
        {
            part: "body",
            bone:
                vrm.humanoid.getNormalizedBoneNode("chest") ??
                vrm.humanoid.getNormalizedBoneNode("spine"),
            radius: height * 0.26,
        },
        {
            part: "left-hand",
            bone: vrm.humanoid.getNormalizedBoneNode("leftHand"),
            radius: height * 0.07,
        },
        {
            part: "right-hand",
            bone: vrm.humanoid.getNormalizedBoneNode("rightHand"),
            radius: height * 0.07,
        },
    ];

    for (const spec of specs) {
        if (!spec.bone) {
            continue;
        }
        const mesh = new Mesh(sphere, material);
        mesh.scale.setScalar(spec.radius);
        // 射线检测不要求 visible=true；关闭可见性可以避免增加任何绘制开销。
        mesh.visible = false;
        vrm.scene.add(mesh);
        hitProxies.push({
            part: spec.part,
            mesh,
            bone: spec.bone,
        });
    }
}

function updateHitProxies(): void {
    if (!vrm) {
        return;
    }
    for (const proxy of hitProxies) {
        proxy.bone.getWorldPosition(hitWorldPosition);
        vrm.scene.worldToLocal(hitWorldPosition);
        proxy.mesh.position.copy(hitWorldPosition);
    }
}

function disposeHitProxies(): void {
    for (const proxy of hitProxies) {
        proxy.mesh.removeFromParent();
        proxy.mesh.geometry.dispose();
    }
    if (hitProxies.length > 0) {
        const material = hitProxies[0].mesh.material;
        if (Array.isArray(material)) {
            material.forEach((item) => item.dispose());
        } else {
            material.dispose();
        }
    }
    hitProxies = [];
}

function pointerPart(event: PointerEvent): CharacterInteractionPart {
    const canvas = renderer?.domElement;
    if (!canvas || !camera || hitProxies.length === 0) {
        return "none";
    }

    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
        return "none";
    }
    pointerNdc.set(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    raycaster.setFromCamera(pointerNdc, camera);
    const hit = raycaster.intersectObjects(
        hitProxies.map((proxy) => proxy.mesh),
        false,
    )[0];
    if (!hit) {
        return "none";
    }
    return hitProxies.find((proxy) => proxy.mesh === hit.object)?.part ?? "none";
}

function emitInteraction(
    action: CharacterInteraction["action"],
    part: CharacterInteractionPart,
): void {
    emit("interact", {
        action,
        part,
        at: Date.now(),
    });
}

function onPointerDown(event: PointerEvent): void {
    if (event.button !== 0 || !renderer) {
        return;
    }
    dragging = false;
    pointerStart = {
        x: event.clientX,
        y: event.clientY,
        at: performance.now(),
        rotationY: vrm?.scene.rotation.y ?? 0,
    };
    renderer.domElement.setPointerCapture(event.pointerId);
}

function onPointerMove(event: PointerEvent): void {
    if (!renderer) {
        return;
    }

    if (!pointerStart) {
        renderer.domElement.style.cursor = pointerPart(event) === "none" ? "default" : "pointer";
        return;
    }

    const dx = event.clientX - pointerStart.x;
    const dy = event.clientY - pointerStart.y;
    if (!dragging && Math.hypot(dx, dy) >= 6) {
        dragging = true;
    }
    if (dragging && vrm) {
        vrm.scene.rotation.y = pointerStart.rotationY + dx * 0.008;
        renderer.domElement.style.cursor = "grabbing";
    }
}

function onPointerUp(event: PointerEvent): void {
    if (!renderer || !pointerStart) {
        return;
    }

    const start = pointerStart;
    pointerStart = null;
    try {
        renderer.domElement.releasePointerCapture(event.pointerId);
    } catch {
        // 指针已被系统取消释放
    }

    if (dragging) {
        dragging = false;
        emitInteraction("drag-end", "none");
        renderer.domElement.style.cursor = pointerPart(event) === "none" ? "default" : "pointer";
        return;
    }

    if (performance.now() - start.at > 600) {
        return;
    }
    const part = pointerPart(event);
    if (part === "none") {
        return;
    }

    if (clickTimer !== null) {
        window.clearTimeout(clickTimer);
        clickTimer = null;
        emitInteraction("double-click", part);
        return;
    }

    clickTimer = window.setTimeout(() => {
        clickTimer = null;
        emitInteraction("click", part);
    }, 240);
}

function onPointerCancel(): void {
    dragging = false;
    pointerStart = null;
    if (renderer) {
        renderer.domElement.style.cursor = "default";
    }
}

function onPointerLeave(): void {
    if (!pointerStart && renderer) {
        renderer.domElement.style.cursor = "default";
    }
}

function tick(timestamp?: number): void {
    frameId = window.requestAnimationFrame(tick);
    if (!renderer || !scene || !camera) {
        return;
    }

    timer.update(timestamp);
    // 切窗口回来时 delta 会很大，钳一下免得表情一顿跳
    const delta = Math.min(timer.getDelta(), 0.1);

    if (vrm) {
        updateHitProxies();
        updateExpressions(delta, timer.getElapsed());
        // 头发那 37 条 spring bone 全靠这一句，漏了就是一头僵发
        vrm.update(delta);
    }

    renderer.render(scene, camera);
}

function configureMaterial(material: Material): void {
    if (!(material instanceof MeshStandardMaterial)) {
        return;
    }

    for (const texture of [material.map, material.emissiveMap]) {
        if (!texture) continue;
        // 贴图是颜色数据，必须按 sRGB 解码；法线/粗糙度贴图仍保持线性。
        texture.colorSpace = SRGBColorSpace;
        texture.needsUpdate = true;
    }

    material.envMapIntensity = 0.72;
    material.roughness = Math.max(0.42, material.roughness);
    material.needsUpdate = true;
}

function onModelLoaded(gltf: GLTF): void {
    const loaded = gltf.userData.vrm as VRM | undefined;
    if (!loaded) {
        fail("文件里没有 VRM 扩展数据，是不是导成了普通 glTF？");
        return;
    }

    vrm = loaded;
    // 这个文件是 VRM 1.0，方向本来就是对的：rotateVRM0() 是给 0.x 模型用的，别调
    VRMUtils.removeUnnecessaryVertices(gltf.scene);

    const meshes = new Set<Mesh>();
    const materials = new Set<Material>();
    const colorTextures = new Set<Texture>();
    // 蒙皮网格的包围盒在绑定时算不准，开视锥剔除会让角色转到某个角度整个消失。
    // 同时显式校正颜色贴图，避免不同 GLTFLoader/纹理缓存路径把 sRGB 贴图当线性数据，
    // 导致材质发灰、发白或看起来“没有上色”。
    vrm.scene.traverse((object) => {
        object.frustumCulled = false;
        if (!(object instanceof Mesh)) return;
        meshes.add(object);
        const objectMaterials = Array.isArray(object.material)
            ? object.material
            : [object.material];
        for (const material of objectMaterials) {
            materials.add(material);
            if (material instanceof MeshStandardMaterial && material.map) {
                colorTextures.add(material.map);
            }
            configureMaterial(material);
        }
    });

    scene?.add(vrm.scene);
    modelBounds = new Box3().setFromObject(vrm.scene);
    createHitProxies();
    applySize();

    state.value = "ready";
    note.value = "";
    const size = modelBounds.getSize(new Vector3());
    console.info(
        `[角色] 3D 模型加载完成：网格=${meshes.size}，材质=${materials.size}，` +
            `颜色贴图=${colorTextures.size}，尺寸=${size.x.toFixed(2)}×${size.y.toFixed(2)}×${size.z.toFixed(2)}`,
    );
    if (colorTextures.size === 0) {
        console.warn("[角色] 3D 模型没有检测到颜色贴图，模型可能显示为白色");
    }
    emit("ready");
}

onMounted(() => {
    const container = containerRef.value;
    if (!container) {
        return;
    }

    try {
        renderer = new WebGLRenderer({ alpha: true, antialias: true });
    } catch (error) {
        fail(`WebGL 初始化失败（${describeError(error)}）`);
        return;
    }
    renderer.outputColorSpace = SRGBColorSpace;
    renderer.toneMapping = NeutralToneMapping;
    renderer.toneMappingExposure = 0.95;
    container.appendChild(renderer.domElement);
    renderer.domElement.addEventListener("pointerdown", onPointerDown);
    renderer.domElement.addEventListener("pointermove", onPointerMove);
    renderer.domElement.addEventListener("pointerup", onPointerUp);
    renderer.domElement.addEventListener("pointercancel", onPointerCancel);
    renderer.domElement.addEventListener("pointerleave", onPointerLeave);

    scene = new Scene();
    camera = new PerspectiveCamera(30, 1, 0.05, 40);

    // 这个 VRM 使用标准 PBR 材质和嵌入贴图。提供柔和的环境光照后，再叠加
    // 少量方向光即可保留服装、头发和脸部贴图的颜色，避免多盏强光把纹理冲成白色。
    const room = new RoomEnvironment();
    const pmrem = new PMREMGenerator(renderer);
    environmentMap = pmrem.fromScene(room, 0.04).texture;
    room.dispose();
    pmrem.dispose();
    scene.environment = environmentMap;
    scene.environmentIntensity = 0.72;

    scene.add(new AmbientLight(0xf3efff, 0.32));
    scene.add(new HemisphereLight(0xf3efff, 0x594b72, 0.42));

    const keyLight = new DirectionalLight(0xffffff, 1.1);
    keyLight.position.set(1.4, 2.2, 2.6);
    scene.add(keyLight);

    const rimLight = new DirectionalLight(0xc9b6ff, 0.35);
    rimLight.position.set(-1.6, 1.5, -2.2);
    scene.add(rimLight);

    resizeObserver = new ResizeObserver(() => applySize());
    resizeObserver.observe(container);
    applySize();

    const loader = new GLTFLoader();
    loader.register((parser) => new VRMLoaderPlugin(parser));
    loader.load(MODEL_URL, onModelLoaded, undefined, (error) =>
        fail(`读不到 ${MODEL_URL}：${describeError(error)}`),
    );

    timer.connect(document);
    timer.reset();
    frameId = window.requestAnimationFrame(tick);
});

onBeforeUnmount(() => {
    window.cancelAnimationFrame(frameId);
    if (clickTimer !== null) {
        window.clearTimeout(clickTimer);
        clickTimer = null;
    }
    resizeObserver?.disconnect();
    resizeObserver = null;
    timer.dispose();

    if (vrm && scene) {
        disposeHitProxies();
        scene.remove(vrm.scene);
        // 贴图、几何体、材质都要显式释放，不然来回切页面会一直涨显存
        VRMUtils.deepDispose(vrm.scene);
    }
    vrm = null;
    modelBounds = null;
    environmentMap?.dispose();
    environmentMap = null;

    if (renderer) {
        renderer.domElement.removeEventListener("pointerdown", onPointerDown);
        renderer.domElement.removeEventListener("pointermove", onPointerMove);
        renderer.domElement.removeEventListener("pointerup", onPointerUp);
        renderer.domElement.removeEventListener("pointercancel", onPointerCancel);
        renderer.domElement.removeEventListener("pointerleave", onPointerLeave);
        renderer.dispose();
        renderer.domElement.remove();
    }
    renderer = null;
    scene = null;
    camera = null;
});
</script>

<style scoped>
.character-stage {
    width: 100%;
    height: 100%;
    overflow: hidden;
}

/* setSize(w, h, false) 不会写 canvas 的内联尺寸，尺寸由这里撑 */
.character-stage :deep(canvas) {
    display: block;
    width: 100%;
    height: 100%;
    touch-action: none;
}

.stage-note {
    position: absolute;
    right: 0;
    bottom: 4px;
    left: 0;
    margin: 0;
    font-size: 11px;
    text-align: center;
    color: rgba(214, 206, 240, 0.55);
    pointer-events: none;
}

.stage-note[data-tone="failed"] {
    color: rgba(240, 200, 200, 0.7);
}
</style>
