import { createEffect, createMemo, createSignal, For, type JSX } from "solid-js";
import { Clock, Search } from "lucide-solid";

/** One emoji plus its searchable keywords, kept as a tuple to avoid duplicating the glyph as an object key. */
type EmojiEntry = readonly [emoji: string, keywords: string];

interface EmojiCategory {
  id: string;
  label: string;
  /** Representative glyph shown on the jump-strip button; not itself part of the category's grid. */
  icon: string;
  entries: EmojiEntry[];
}

// Grouped roughly along CLDR's emoji ordering. Kept to a curated, well-known
// subset per category (a few hundred total) rather than the full Unicode set,
// so every entry can carry real keywords instead of just the glyph itself.
const CATEGORIES: EmojiCategory[] = [
  {
    id: "smileys",
    label: "Smileys & people",
    icon: "😀",
    entries: [
      ["😀", "grinning happy smile"], ["😃", "grinning open mouth happy"], ["😄", "grinning smiling eyes happy"], ["😁", "beaming grin happy"],
      ["😆", "laughing satisfied haha"], ["😅", "sweat smile nervous laugh"], ["😂", "joy tears laughing lol"], ["🤣", "rofl rolling floor laughing lol"],
      ["🙂", "slightly smiling happy"], ["🙃", "upside down silly"], ["😉", "wink flirt"], ["😊", "blush smiling happy shy"],
      ["😇", "innocent halo angel"], ["🥰", "in love hearts smiling adoring"], ["😍", "heart eyes love crush"], ["🤩", "star struck excited amazed"],
      ["😘", "kiss blow a kiss love"], ["😋", "yum delicious tasty tongue"], ["😛", "tongue out playful"], ["😝", "tongue closed eyes silly"],
      ["🤪", "zany crazy wild goofy"], ["🤨", "raised eyebrow skeptical suspicious"], ["🧐", "monocle inspecting curious"], ["🤓", "nerd glasses geek"],
      ["😎", "cool sunglasses awesome"], ["🥳", "party celebrate birthday"], ["😏", "smirk sly flirt"], ["😒", "unamused annoyed meh"],
      ["😞", "disappointed sad"], ["😔", "pensive sad thoughtful"], ["😟", "worried concerned"], ["🙁", "frown sad"],
      ["☹️", "frowning sad"], ["😣", "persevere struggling"], ["😖", "confounded frustrated"], ["😫", "tired exhausted anguished"],
      ["😩", "weary tired exhausted"], ["🥺", "pleading puppy eyes begging"], ["😢", "crying sad tear"], ["😭", "sobbing crying loud bawling"],
      ["😤", "huffing frustrated proud steam"], ["😠", "angry mad"], ["😡", "furious rage angry red"], ["🤬", "cursing swearing angry symbols"],
      ["🤯", "mind blown shocked exploding head"], ["😳", "flushed embarrassed shocked"], ["🥵", "hot sweating overheated"], ["🥶", "cold freezing"],
      ["😱", "scream shocked scared"], ["😨", "fearful scared"], ["😰", "anxious sweat nervous"], ["😓", "sweat downcast tired"],
      ["🤗", "hug hugging warm"], ["🤔", "thinking hmm pondering"], ["🤭", "giggle oops covering mouth"], ["🤫", "shush quiet secret"],
      ["🤥", "lying pinocchio liar"], ["😶", "no mouth speechless"], ["😐", "neutral straight face"], ["😑", "expressionless blank"],
      ["😬", "grimace awkward cringe"], ["🙄", "eye roll annoyed"], ["😯", "surprised gasp"], ["😮", "open mouth surprised"],
      ["😲", "astonished shocked"], ["🥱", "yawn bored sleepy tired"], ["😴", "sleeping zzz asleep"], ["🤤", "drooling sleepy"],
      ["😪", "sleepy tired"], ["😵", "dizzy confused knocked out"], ["🤐", "zipper mouth silent secret"], ["🥴", "woozy dizzy drunk"],
      ["🤢", "nauseated sick disgusted"], ["🤮", "vomiting sick throw up"], ["🤧", "sneezing sick"], ["😷", "mask sick ill"],
      ["🤒", "thermometer sick fever"], ["🤕", "head bandage hurt injured"], ["🤑", "money mouth rich greedy"], ["🤠", "cowboy hat"],
      ["😈", "devil smiling mischievous"], ["👿", "devil angry imp"], ["👹", "ogre monster"], ["👺", "goblin monster mask"],
      ["🤡", "clown"], ["💩", "poop pile of poo"], ["👻", "ghost boo halloween"], ["💀", "skull dead death"],
      ["☠️", "skull crossbones danger"], ["👽", "alien ufo"], ["🤖", "robot bot"], ["🎃", "jack o lantern pumpkin halloween"],
      ["😺", "cat smiling happy"], ["😸", "cat grin happy"], ["😻", "cat heart eyes love"], ["😿", "cat crying sad"],
      ["👶", "baby infant"], ["🧒", "child kid"], ["👦", "boy"], ["👧", "girl"],
      ["🧑", "person adult"], ["👨", "man"], ["👩", "woman"], ["👴", "old man grandpa"],
      ["👵", "old woman grandma"], ["🤴", "prince"], ["👸", "princess"], ["🥷", "ninja"],
      ["🦸", "superhero"], ["🦹", "supervillain"], ["🧙", "mage wizard witch"], ["👼", "angel baby cherub"],
    ],
  },
  {
    id: "gestures",
    label: "Gestures",
    icon: "👋",
    entries: [
      ["👋", "wave hello hi bye"], ["🤚", "raised back of hand stop"], ["🖐️", "hand splayed stop five"], ["✋", "raised hand stop high five"],
      ["🖖", "vulcan salute spock"], ["👌", "ok okay perfect"], ["🤏", "pinch small tiny little bit"], ["✌️", "peace victory"],
      ["🤞", "fingers crossed hope luck"], ["🤟", "love you sign"], ["🤘", "rock on horns metal"], ["🤙", "call me shaka hang loose"],
      ["👈", "point left"], ["👉", "point right"], ["👆", "point up"], ["👇", "point down"],
      ["☝️", "point up index"], ["👍", "thumbs up like good yes"], ["👎", "thumbs down dislike bad no"], ["✊", "fist power"],
      ["👊", "fist bump punch"], ["🤛", "fist bump left"], ["🤜", "fist bump right"], ["👏", "clap applause well done"],
      ["🙌", "raised hands celebrate praise"], ["👐", "open hands hug"], ["🤲", "palms up together pray offer"], ["🤝", "handshake deal agreement"],
      ["🙏", "pray please thanks folded hands"], ["✍️", "writing hand"], ["💅", "nail polish manicure sassy"], ["🤳", "selfie"],
      ["💪", "muscle strong flex bicep"], ["👂", "ear listen"], ["👃", "nose smell"], ["🧠", "brain smart think"],
      ["👀", "eyes look watching"], ["👁️", "eye watching single"], ["👅", "tongue lick"], ["👄", "mouth lips kiss"],
    ],
  },
  {
    id: "hearts",
    label: "Hearts",
    icon: "❤️",
    entries: [
      ["❤️", "red heart love"], ["🧡", "orange heart"], ["💛", "yellow heart"], ["💚", "green heart"],
      ["💙", "blue heart"], ["💜", "purple heart"], ["🖤", "black heart"], ["🤍", "white heart"],
      ["🤎", "brown heart"], ["💔", "broken heart heartbreak sad"], ["❤️‍🔥", "heart on fire passion"], ["❤️‍🩹", "mending heart healing"],
      ["❣️", "heart exclamation"], ["💕", "two hearts love"], ["💞", "revolving hearts love"], ["💓", "beating heart heartbeat"],
      ["💗", "growing heart love"], ["💖", "sparkling heart love"], ["💘", "heart arrow cupid love"], ["💝", "heart gift love"],
      ["💟", "heart decoration"], ["♥️", "heart suit love"],
    ],
  },
  {
    id: "animals",
    label: "Animals & nature",
    icon: "🐶",
    entries: [
      ["🐶", "dog puppy"], ["🐱", "cat kitten"], ["🐭", "mouse"], ["🐹", "hamster"],
      ["🐰", "rabbit bunny"], ["🦊", "fox"], ["🐻", "bear"], ["🐼", "panda"],
      ["🐨", "koala"], ["🐯", "tiger"], ["🦁", "lion"], ["🐮", "cow"],
      ["🐷", "pig"], ["🐸", "frog"], ["🐵", "monkey"], ["🙈", "see no evil monkey"],
      ["🙉", "hear no evil monkey"], ["🙊", "speak no evil monkey"], ["🐔", "chicken"], ["🐧", "penguin"],
      ["🐦", "bird"], ["🦆", "duck"], ["🦉", "owl"], ["🐺", "wolf"],
      ["🐴", "horse"], ["🦄", "unicorn"], ["🐝", "bee"], ["🦋", "butterfly"],
      ["🐌", "snail"], ["🐢", "turtle tortoise"], ["🐍", "snake"], ["🐙", "octopus"],
      ["🦀", "crab"], ["🐠", "fish tropical"], ["🐬", "dolphin"], ["🐳", "whale"],
      ["🦈", "shark"], ["🐘", "elephant"], ["🐕", "dog"], ["🐈", "cat"],
      ["🌵", "cactus desert"], ["🌲", "tree evergreen"], ["🌳", "tree deciduous"], ["🌱", "seedling sprout plant"],
      ["🌿", "herb plant leaf"], ["🍀", "four leaf clover luck"], ["🍁", "maple leaf fall autumn"], ["🌸", "cherry blossom flower"],
      ["🌹", "rose flower"], ["🌻", "sunflower"], ["🌞", "sun face"], ["🌙", "moon crescent night"],
      ["🌈", "rainbow pride"], ["⭐", "star"], ["🔥", "fire hot lit"], ["☀️", "sun sunny"],
      ["⛅", "partly cloudy weather"], ["🌧️", "rain cloud weather"], ["❄️", "snowflake cold winter"], ["☃️", "snowman winter"],
      ["🌊", "wave ocean water"],
    ],
  },
  {
    id: "food",
    label: "Food",
    icon: "🍕",
    entries: [
      ["☕", "coffee"], ["🍵", "tea"], ["🧃", "juice box drink"], ["🥤", "soda drink cup"],
      ["🍺", "beer"], ["🍷", "wine"], ["🍸", "cocktail martini"], ["🍕", "pizza"],
      ["🍔", "burger hamburger"], ["🍟", "fries"], ["🌭", "hot dog"], ["🥪", "sandwich"],
      ["🌮", "taco"], ["🌯", "burrito wrap"], ["🥗", "salad healthy"], ["🍿", "popcorn"],
      ["🥓", "bacon"], ["🍳", "egg frying cooking"], ["🥞", "pancakes"], ["🍞", "bread loaf"],
      ["🧀", "cheese"], ["🍗", "chicken leg drumstick"], ["🍖", "meat bone"], ["🥩", "steak meat"],
      ["🍣", "sushi"], ["🍜", "noodles ramen soup"], ["🍝", "pasta spaghetti"], ["🍚", "rice bowl"],
      ["🍲", "stew pot food"], ["🍦", "ice cream soft serve"], ["🍨", "ice cream bowl"], ["🎂", "birthday cake"],
      ["🧁", "cupcake"], ["🍪", "cookie"], ["🍩", "donut doughnut"], ["🍫", "chocolate"],
      ["🍬", "candy sweet"], ["🍭", "lollipop candy"], ["🍯", "honey"], ["🍎", "apple"],
      ["🍊", "orange tangerine"], ["🍋", "lemon"], ["🍌", "banana"], ["🍉", "watermelon"],
      ["🍇", "grapes"], ["🍓", "strawberry"], ["🍒", "cherries"], ["🍑", "peach"],
      ["🥑", "avocado"], ["🍅", "tomato"], ["🥕", "carrot"],
    ],
  },
  {
    id: "activities",
    label: "Activities",
    icon: "⚽",
    entries: [
      ["⚽", "soccer football"], ["🏀", "basketball"], ["🏈", "american football"], ["⚾", "baseball"],
      ["🎾", "tennis"], ["🏐", "volleyball"], ["🏓", "ping pong table tennis"], ["🏸", "badminton"],
      ["🥊", "boxing glove fight"], ["⛳", "golf"], ["🏹", "archery bow arrow"], ["🎣", "fishing"],
      ["🎿", "skiing"], ["🏂", "snowboarding"], ["🏋️", "weightlifting gym"], ["🏊", "swimming"],
      ["🚴", "cycling bike"], ["🏆", "trophy win champion"], ["🥇", "gold medal first"], ["🥈", "silver medal second"],
      ["🥉", "bronze medal third"], ["🏅", "medal award"], ["🎪", "circus tent"], ["🎭", "theater masks drama"],
      ["🎨", "art painting palette"], ["🎬", "movie clapper film"], ["🎤", "microphone karaoke sing"], ["🎧", "headphones music"],
      ["🎵", "music note"], ["🎶", "music notes"], ["🎹", "piano keyboard"], ["🥁", "drum"],
      ["🎸", "guitar"], ["🎮", "video game controller"], ["🕹️", "joystick arcade"], ["🎲", "dice game"],
      ["🧩", "puzzle jigsaw"], ["🎯", "dart target bullseye"], ["🎳", "bowling"], ["🎉", "party popper celebrate"],
      ["🎊", "confetti ball celebrate"], ["🎈", "balloon party"], ["🎁", "gift present"], ["🎀", "ribbon bow"],
    ],
  },
  {
    id: "travel",
    label: "Travel",
    icon: "✈️",
    entries: [
      ["🚗", "car automobile"], ["🚕", "taxi cab"], ["🚙", "suv car"], ["🚌", "bus"],
      ["🚓", "police car"], ["🚑", "ambulance"], ["🚒", "fire truck"], ["🚚", "truck delivery"],
      ["🚲", "bicycle bike"], ["🛵", "scooter moped"], ["🏍️", "motorcycle"], ["🚨", "siren police light"],
      ["🚂", "train steam locomotive"], ["🚆", "train"], ["✈️", "airplane flight travel plane"], ["🚀", "rocket launch space"],
      ["🚁", "helicopter"], ["⛵", "sailboat boat"], ["🚤", "speedboat boat"], ["⚓", "anchor ship"],
      ["🏠", "house home"], ["🏢", "office building"], ["🏥", "hospital"], ["🏨", "hotel"],
      ["🏰", "castle"], ["⛪", "church"], ["🗼", "tower landmark"], ["🗽", "statue of liberty landmark"],
      ["🌉", "bridge"], ["🗺️", "map world"], ["🧭", "compass direction"], ["🏔️", "mountain snow"],
      ["⛰️", "mountain"], ["🌋", "volcano"], ["🏖️", "beach umbrella"], ["🎡", "ferris wheel"],
      ["🎢", "roller coaster"],
    ],
  },
  {
    id: "objects",
    label: "Objects",
    icon: "💡",
    entries: [
      ["📱", "phone mobile smartphone"], ["💻", "laptop computer"], ["⌨️", "keyboard"], ["🖥️", "desktop computer monitor"],
      ["📷", "camera photo"], ["📸", "camera flash photo"], ["🎥", "movie camera video"], ["📞", "telephone call phone"],
      ["☎️", "telephone landline"], ["📺", "tv television"], ["📻", "radio"], ["⏰", "alarm clock"],
      ["⌚", "watch time"], ["🔋", "battery"], ["🔌", "plug electric"], ["💡", "light bulb idea"],
      ["🔦", "flashlight torch"], ["💰", "money bag"], ["💳", "credit card payment"], ["💎", "gem diamond"],
      ["🔧", "wrench tool"], ["🔨", "hammer tool"], ["⚙️", "gear settings"], ["🔗", "link chain"],
      ["🔪", "knife kitchen"], ["🚪", "door"], ["🛏️", "bed sleep"], ["🚽", "toilet bathroom"],
      ["🚿", "shower"], ["🛁", "bathtub bath"], ["🔑", "key unlock"], ["🎁", "gift present box"],
      ["📦", "package box shipping"], ["✉️", "envelope mail letter"], ["📧", "email"], ["📜", "scroll document"],
      ["📊", "bar chart graph"], ["📈", "chart increasing up"], ["📅", "calendar date"], ["📁", "folder file"],
      ["📚", "books stack"], ["📖", "open book read"], ["🔖", "bookmark tag"], ["📎", "paperclip"],
      ["✂️", "scissors cut"], ["📝", "memo note write"], ["🔒", "locked lock secure"], ["🔓", "unlocked open"],
    ],
  },
  {
    id: "symbols",
    label: "Symbols",
    icon: "✅",
    entries: [
      ["✅", "check mark done yes ok"], ["❌", "cross mark no wrong"], ["⚠️", "warning caution"], ["❓", "question mark"],
      ["❗", "exclamation mark"], ["‼️", "double exclamation"], ["💯", "hundred perfect score"], ["💢", "anger symbol mad"],
      ["💥", "boom explosion collision"], ["💫", "dizzy stars sparkle"], ["💦", "sweat drops splash"], ["💨", "dashing wind fast"],
      ["💣", "bomb explosive"], ["💬", "speech bubble chat"], ["🗨️", "speech balloon left"], ["💭", "thought bubble thinking"],
      ["💤", "zzz sleep snoring"], ["♻️", "recycle recycling"], ["⚡", "lightning bolt zap electric"], ["🚫", "prohibited no not allowed"],
      ["✔️", "check mark tick"], ["➕", "plus add"], ["➖", "minus subtract"], ["🔄", "refresh reload cycle"],
      ["🆗", "ok symbol"], ["🆕", "new symbol"], ["🆒", "cool symbol"], ["©️", "copyright"],
      ["®️", "registered trademark"], ["™️", "trademark"], ["🔴", "red circle"], ["🟠", "orange circle"],
      ["🟡", "yellow circle"], ["🟢", "green circle"], ["🔵", "blue circle"], ["🟣", "purple circle"],
      ["⚫", "black circle"], ["⚪", "white circle"], ["⬛", "black square"], ["⬜", "white square"],
    ],
  },
];

/** Flat data derived once for search and accessible labels. */
const ALL_ENTRIES = CATEGORIES.flatMap((category) => category.entries);
const KEYWORDS: Record<string, string> = Object.fromEntries(ALL_ENTRIES);

const DEFAULT_RECENT_KEY = "rust-meow-recent-emoji";
const MAX_RECENT = 32;

interface EmojiSection {
  id: string;
  label: string;
  emojis: string[];
  /** Offset of this section's first emoji within the flattened, currently visible list. */
  startIndex: number;
}

export function EmojiPicker(props: {
  onPick: (emoji: string) => void;
  /** localStorage key for the recently-used list, default "rust-meow-recent-emoji". */
  recentKey?: string;
  /** Denser grid for the reaction popover. */
  compact?: boolean;
}): JSX.Element {
  const recentKey = () => props.recentKey ?? DEFAULT_RECENT_KEY;
  const [recent, setRecent] = createSignal<string[]>(readRecent(recentKey()));
  const [query, setQuery] = createSignal("");
  const [activeCategory, setActiveCategory] = createSignal("");
  const [activeIndex, setActiveIndex] = createSignal(0);

  let inputRef: HTMLInputElement | undefined;
  let gridRef: HTMLDivElement | undefined;
  const cellRefs: (HTMLDivElement | undefined)[] = [];
  const sectionRefs = new Map<string, HTMLDivElement>();

  const searching = createMemo(() => query().trim().length > 0);

  const filteredEmojis = createMemo(() => {
    const q = query().trim().toLocaleLowerCase();
    if (!q) return [];
    const seen = new Set<string>();
    const result: string[] = [];
    for (const [emoji, keywords] of ALL_ENTRIES) {
      if (seen.has(emoji)) continue;
      if (emoji === q || keywords.includes(q)) {
        seen.add(emoji);
        result.push(emoji);
      }
    }
    return result;
  });

  /** Sections rendered into the grid, in order; keyboard nav walks this flattened. */
  const sections = createMemo<EmojiSection[]>(() => {
    if (searching()) {
      const matches = filteredEmojis();
      return matches.length > 0 ? [{ id: "search", label: "Search results", emojis: matches, startIndex: 0 }] : [];
    }
    const list: EmojiSection[] = [];
    let offset = 0;
    if (recent().length > 0) {
      list.push({ id: "recent", label: "Recently used", emojis: recent(), startIndex: offset });
      offset += recent().length;
    }
    for (const category of CATEGORIES) {
      list.push({ id: category.id, label: category.label, emojis: category.entries.map(([emoji]) => emoji), startIndex: offset });
      offset += category.entries.length;
    }
    return list;
  });

  const totalVisible = createMemo(() => sections().reduce((sum, section) => sum + section.emojis.length, 0));
  const columns = () => (props.compact ? 10 : 8);

  createEffect(() => {
    const max = totalVisible() - 1;
    if (activeIndex() > max) setActiveIndex(Math.max(0, max));
  });

  function readRecent(key: string): string[] {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return [];
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      // Never trust stored JSON: keep only non-empty strings, capped.
      return parsed.filter((value): value is string => typeof value === "string" && value.length > 0).slice(0, MAX_RECENT);
    } catch {
      return [];
    }
  }

  function persistRecent(next: string[]) {
    try {
      localStorage.setItem(recentKey(), JSON.stringify(next));
    } catch {
      // Recents are a nicety; storage can legitimately be unavailable (private mode, quota).
    }
  }

  function pick(emoji: string) {
    setRecent((current) => {
      const next = [emoji, ...current.filter((item) => item !== emoji)].slice(0, MAX_RECENT);
      persistRecent(next);
      return next;
    });
    props.onPick(emoji);
  }

  function focusIndex(index: number) {
    const clamped = Math.max(0, Math.min(index, totalVisible() - 1));
    setActiveIndex(clamped);
    cellRefs[clamped]?.focus();
  }

  function onGridKeyDown(event: KeyboardEvent) {
    if (totalVisible() === 0) return;
    switch (event.key) {
      case "ArrowRight":
        event.preventDefault();
        focusIndex(activeIndex() + 1);
        break;
      case "ArrowLeft":
        event.preventDefault();
        focusIndex(activeIndex() - 1);
        break;
      case "ArrowDown":
        event.preventDefault();
        focusIndex(activeIndex() + columns());
        break;
      case "ArrowUp":
        event.preventDefault();
        focusIndex(activeIndex() - columns());
        break;
      case "Enter":
      case " ": {
        event.preventDefault();
        const emoji = flatEmojiAt(activeIndex());
        if (emoji) pick(emoji);
        break;
      }
      // Escape is intentionally left alone: it bubbles to whichever popover
      // is hosting this picker (Composer / MessageBubble), which is the only
      // thing that knows how to close itself.
    }
  }

  function flatEmojiAt(index: number): string | undefined {
    for (const section of sections()) {
      if (index < section.startIndex || index >= section.startIndex + section.emojis.length) continue;
      return section.emojis[index - section.startIndex];
    }
    return undefined;
  }

  function jumpToCategory(id: string) {
    setActiveCategory(id);
    sectionRefs.get(id)?.scrollIntoView({ block: "start", behavior: "smooth" });
  }

  function onSearchKeyDown(event: KeyboardEvent) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      focusIndex(0);
    } else if (event.key === "Enter") {
      event.preventDefault();
      const first = flatEmojiAt(0);
      if (first) pick(first);
    }
    // Escape falls through unhandled, same reasoning as the grid handler.
  }

  return (
    <div
      class={`popover emoji-picker${props.compact ? " compact" : ""}`}
      style={props.compact ? { width: "292px", "max-height": "300px" } : undefined}
    >
      <div class="emoji-picker-header">
        <label class="search-field">
          <Search size={16} />
          <input
            ref={inputRef}
            value={query()}
            placeholder="Search emoji"
            aria-label="Search emoji"
            onInput={(event) => {
              setQuery(event.currentTarget.value);
              setActiveIndex(0);
            }}
            onKeyDown={onSearchKeyDown}
          />
        </label>
      </div>

      {!searching() && (
        <div class="emoji-category-strip">
          {recent().length > 0 && (
            <button
              type="button"
              class={`emoji-category${activeCategory() === "recent" ? " active" : ""}`}
              aria-label="Recently used"
              title="Recently used"
              onClick={() => jumpToCategory("recent")}
            >
              <Clock size={15} />
            </button>
          )}
          <For each={CATEGORIES}>
            {(category) => (
              <button
                type="button"
                class={`emoji-category${activeCategory() === category.id ? " active" : ""}`}
                aria-label={category.label}
                title={category.label}
                onClick={() => jumpToCategory(category.id)}
              >
                {category.icon}
              </button>
            )}
          </For>
        </div>
      )}

      <div
        class="emoji-grid"
        ref={gridRef}
        role="listbox"
        aria-label="Emoji"
        style={props.compact ? { "grid-template-columns": `repeat(${columns()}, 1fr)` } : undefined}
        onKeyDown={onGridKeyDown}
      >
        <For each={sections()} fallback={<div class="emoji-section-label" style={{ "grid-column": "1 / -1" }}>No emoji found</div>}>
          {(section) => (
            <>
              <div
                class="emoji-section-label"
                style={{ "grid-column": "1 / -1" }}
                ref={(el) => sectionRefs.set(section.id, el)}
              >
                {section.label}
              </div>
              <For each={section.emojis}>
                {(emoji, localIndex) => {
                  const index = section.startIndex + localIndex();
                  return (
                    <div
                      ref={(el) => (cellRefs[index] = el)}
                      class="emoji-button"
                      role="option"
                      aria-selected={activeIndex() === index}
                      aria-label={KEYWORDS[emoji]?.split(" ")[0] ?? emoji}
                      tabIndex={activeIndex() === index ? 0 : -1}
                      onClick={() => {
                        setActiveIndex(index);
                        pick(emoji);
                      }}
                      onFocus={() => setActiveIndex(index)}
                    >
                      {emoji}
                    </div>
                  );
                }}
              </For>
            </>
          )}
        </For>
      </div>
    </div>
  );
}
