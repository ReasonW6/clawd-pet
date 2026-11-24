// The pet's script: which clawd-400 animation (by slug) plays when.
// Lists are picked from at random; a { slug: weight } map is picked from by weight.
// Edit freely; slugs are in assets/clawd/manifest.json.

// ------------------------------------------------------------ Claude Code states

window.ANIMS = {
  // Calm loops it rests in between scenes of its idle life (a mood may swap these out).
  idle: ["tea_sip", "vibe_nod", "desk_coffee", "read_glasses", "emo_meditate", "bubble_wand", "life_goldfish", "fidget_spinner", "emo_daydream"],

  thinking: ["dev_thinking", "desk_think", "idea_bulb"],
  tools: {
    edit: { desk_typing: 30, dev_laptop_front: 30, dev_matrix: 30, cc_code_bricks: 30 },
    read: ["read_stack", "dev_docs_scroll"],
    search: ["cc_code_search"],
    bash: ["dev_terminal"],
    git: ["dev_git_graph"], // status, log, diff...; the rest are in GIT_ANIMS
    test: ["cc_test_run"], // no verdict yet: testPassed / testFailed follow
    install: ["dev_node_modules"],
    build: ["dev_compile_bar"],
    web: ["cc_web_search", "cc_web_read"],
    browser: ["cc_browser_pane"], // the desktop app's own browser pane
    remoteBrowser: ["cc_browser_remote"], // a browser of its own (Chrome, ego...)
    computer: ["cc_computer_use"],
    agent: ["cc_agent_wait"],
    todo: ["dev_kanban"],
    mcp: ["cc_mcp_cart"],
    other: ["dev_robot_arm"],
  },
  agentSent: ["cc_agent_dispatch"], // once, as the Agent tool sends one off
  subagents: ["cc_agent_wait"],
  testPassed: ["dev_test_suite"],
  testFailed: ["cc_test_fail"],
  compacting: ["cc_compact_scroll"],
  cleared: ["life_sweep_floor"],
  permission: ["emo_pretty_please"],
  allowed: ["emo_thumbs_up"],
  denied: ["emo_sad_shuffle", "emo_puffed_cheeks"],
  waiting: ["emo_impatient"],
  // Looped while waiting for an answer, until it turns impatient (`waiting`).
  asking: ["emo_confused"], // AskUserQuestion
  planReady: ["dev_slide_chart", "cos_teacher_chalk"], // ExitPlanMode presents the plan
  elicitation: ["cos_mail_delivery"], // an MCP server hands over a form
  // One-shots once the answer is in.
  answered: ["idea_ding"], // question answered / form submitted
  planApproved: ["emo_determined"],
  interrupted: ["cos_crossing_guard", "desk_flail"], // you stopped it mid-turn
  toolError: ["emo_facepalm", "emo_awkward"],
  manyErrors: ["dev_this_is_fine"],
  apiError: ["dev_bsod"],
  longTask: ["dev_coffee_to_code", "dev_hourglass", "dev_pomodoro"],
  done: ["dev_ship_it", "emo_victory_dance", "dev_lgtm", "emo_thumbs_up", "cc_task_tower"],
  bigDone: ["dev_deploy_rocket", "emo_joy_burst", "sport_podium"],
  sleepyDone: ["emo_yawn"],
  hello: ["emo_nihao"], // the pet itself starting up
  milestone: ["sea_party_popper", "emo_joy_burst"], // how long you've known each other (memory)
  weeklyCard: ["dev_slide_chart"], // holding up the week's recap card

  // ---------------------------------------------------------- daily life
  bedtime: ["life_brush_teeth"], // before a night's sleep, not a nap
  yawn: ["emo_yawn"],
  sleepNight: ["life_bed_sleep"],
  sleepNap: ["read_doze"],
  // Dreaming over its memory (memory.rs), in the pose it sleeps in; they take turns.
  dreamNight: ["dream_night_stars", "dream_night_code", "dream_night_hearts", "dream_night_food", "dream_night_fly"],
  dreamNap: ["dream_nap_castle", "dream_nap_fish", "dream_nap_tea"],
  wakeAlarm: ["life_alarm_snooze"],
  wakeStartled: ["emo_shock_jump"],
  wakeGrumpy: ["emo_grumpy_pout", "emo_eye_roll"],
  stretch: ["stretch_tall", "sport_warmup", "sport_jumping_jacks"],

  // ---------------------------------------------------------- interaction
  click: ["emo_ticklish", "emo_giggle", "emo_wink", "emo_shy", "emo_blow_kiss"],
  clickSpam: ["emo_dizzy", "emo_tantrum", "emo_furious_stomp"],
  petted: ["emo_lovestruck", "emo_heart_pound", "cos_cat_purr", "emo_self_hug"],
  noticed: ["turn_around", "emo_wink", "dev_cursor_chase"],
  dragged: ["emo_scared", "emo_panic_circles", "astro_spin"],
  dropped: ["emo_dizzy", "emo_relieved"],
  fileHover: ["emo_awe"],
  fileDrop: ["dev_drag_drop"],

  // ---------------------------------------------------------- AI chat (all at one desk)
  chatListen: ["chat_listen"], // the input box is open
  chatPonder: ["chat_ponder"], // waiting for the first word of the reply
  chatTyping: ["desk_typing"], // the reply coming in
  chatIdle: ["desk_coffee"], // the reply is up
  chatSnap: ["chat_snap"], // the model takes a screenshot
};

// Human readable status for each tool category.
window.TOOL_LABELS = {
  edit: "写代码",
  read: "读文件",
  search: "翻找线索",
  bash: "跑命令",
  git: "摆弄 Git",
  test: "跑测试",
  install: "装依赖",
  build: "编译中",
  web: "上网查资料",
  browser: "用浏览器",
  remoteBrowser: "操作浏览器",
  computer: "操控电脑",
  agent: "派出小分队",
  todo: "排计划",
  mcp: "调用 MCP",
  other: "忙活中",
};

window.toolCategory = function toolCategory(name = "", input = {}) {
  if (/^(Edit|MultiEdit|Write|NotebookEdit)$/.test(name)) return "edit";
  if (/^(Read|NotebookRead)$/.test(name)) return "read";
  if (/^(Grep|Glob|LS|ToolSearch)$/.test(name)) return "search";
  if (/^(WebFetch|WebSearch)$/.test(name)) return "web";
  if (/^(Task|Agent)$/.test(name)) return "agent";
  if (/^(TodoWrite|TaskCreate|TaskUpdate|TaskList)$/.test(name)) return "todo";
  if (name.startsWith("mcp__")) {
    if (/^mcp__(remote-devices__)?Claude_Browser__/.test(name)) return "browser";
    if (/^mcp__.*(claude-in-chrome|playwright|chrome-devtools|puppeteer)/i.test(name)) return "remoteBrowser";
    if (/^mcp__(computer-use__|remote-devices__computer)/.test(name)) return "computer";
    if (/exa|tavily|web_?search|web_?fetch|firecrawl/i.test(name)) return "web";
    return "mcp";
  }
  if (/^(Bash|PowerShell|Monitor)$/.test(name)) {
    const cmd = String(input.command || "");
    if (/\bego-browser\s/.test(cmd)) return "remoteBrowser";
    if (/\bgit\s/.test(cmd)) return "git";
    if (/\b(test|tests|jest|vitest|pytest|mocha)\b/.test(cmd)) return "test";
    if (/\b(npm|pnpm|yarn|bun|pip|uv|cargo)\s+(i|install|add|ci)\b/.test(cmd)) return "install";
    if (/\b(build|compile|tsc|make|cargo\s+b)\b/.test(cmd)) return "build";
    return "bash";
  }
  return "other";
};

// What a git command Claude runs looks like; anything else is ANIMS.tools.git.
window.GIT_ANIMS = {
  init: ["git_init"],
  clone: ["git_clone"],
  add: ["git_add"],
  commit: ["git_commit"],
  push: ["git_push"],
  pull: ["git_pull"],
  fetch: ["git_pull"],
  branch: ["git_branch"],
  switch: ["git_switch"],
  checkout: ["git_switch"],
  merge: ["git_merge"],
  rebase: ["git_rebase"],
  stash: ["git_stash"],
  reset: ["git_reset"],
  restore: ["git_reset"],
  revert: ["git_reset"],
  "cherry-pick": ["git_cherry_pick"],
};

/** Animations for a git command line: the last git subcommand in it that has its own
 *  (`git add -A && git commit` is a commit). `git branch` only counts when it makes one. */
window.gitAnims = function gitAnims(cmd = "") {
  let found = null;
  for (const [, sub, rest] of String(cmd).matchAll(/\bgit(?:\s+-[Cc]\s+\S+)*\s+([a-z-]+)([^&|;\n]*)/g)) {
    if (sub === "branch" && !/^\s+[^-\s]/.test(rest)) continue;
    // checkout -b, switch -c: a branch is born
    if (/^(checkout|switch)$/.test(sub) && /\s-[bcB]\b/.test(rest)) found = GIT_ANIMS.branch;
    else if (GIT_ANIMS[sub]) found = GIT_ANIMS[sub];
  }
  return found || ANIMS.tools.git;
};

// ------------------------------------------------------------ what the user does on the computer
// kind -> { anims, say?, cooldown? (seconds, default 20) }

window.SYS_EVENTS = {
  "file-in": { anims: ["dev_drag_drop"] },
  zip: { anims: ["dev_zip"], say: "压缩打包，搞定～" },
  download: { anims: ["cos_mail_delivery", "sea_gift_unwrap"], say: "有新文件到货啦～" },
  screenshot: { anims: ["life_photo_polaroid", "life_selfie"], say: "咔嚓！" },
  trash: { anims: ["life_trash_out"] },
  "trash-empty": { anims: ["life_sweep_floor", "life_vacuum"], say: "回收站清空，一身轻松～" },
  clipboard: { anims: ["dev_copy_paste"], cooldown: 60 },
  "battery-low": { anims: ["dev_battery"], say: "快没电啦，插上电源吧！", cooldown: 600 },
  "power-plug": { anims: ["dev_cable_plug"], say: "充上电啦～" },
  offline: { anims: ["dev_wifi_search", "dev_404"], say: "网断了…我找找信号" },
  online: { anims: ["dev_packet_ping", "emo_relieved"], say: "网回来啦～" },
  dark: { anims: ["dev_dark_mode"] },
  light: { anims: ["sea_day_night"] },
  "git-init": { anims: ["git_init"], say: "新仓库，开张啦～" },
  "git-clone": { anims: ["git_clone"] },
  "git-add": { anims: ["git_add"], cooldown: 60 },
  "git-commit": { anims: ["git_commit"] },
  "git-push": { anims: ["git_push"], say: "推上去啦～" },
  "git-pull": { anims: ["git_pull"] },
  "git-switch": { anims: ["git_switch"] },
  "git-merge": { anims: ["git_merge"] },
  "git-rebase": { anims: ["git_rebase"] },
  "git-stash": { anims: ["git_stash"] },
  "git-reset": { anims: ["git_reset"] },
  "git-cherry-pick": { anims: ["git_cherry_pick"] },
  // The Claude desktop app starting up and quitting (not a window coming and going).
  "claude-open": { anims: ["cc_app_open"], cooldown: 30 },
  "claude-quit": { anims: ["cc_app_close"], say: "Claude 下班啦，辛苦～", cooldown: 30 },
};

// Foreground application (process name) -> category -> animations.
window.APP_CATEGORIES = {
  music: ["cloudmusic.exe", "qqmusic.exe", "spotify.exe", "kugou.exe", "kwmusic.exe", "foobar2000.exe", "applemusic.exe"],
  video: ["potplayermini64.exe", "potplayer.exe", "vlc.exe", "mpv.exe", "哔哩哔哩.exe", "bilibili.exe", "qqlive.exe", "qyclient.exe"],
  game: ["steam.exe", "steamwebhelper.exe", "wegame.exe", "yuanshen.exe", "genshinimpact.exe", "starrail.exe", "leagueclientux.exe", "minecraft.exe"],
  code: ["code.exe", "cursor.exe", "idea64.exe", "pycharm64.exe", "webstorm64.exe", "devenv.exe", "studio64.exe", "zed.exe"],
  terminal: ["windowsterminal.exe", "wezterm-gui.exe", "alacritty.exe"],
  chat: ["wechat.exe", "weixin.exe", "qq.exe", "telegram.exe", "discord.exe", "dingtalk.exe", "feishu.exe", "lark.exe", "slack.exe"],
  design: ["figma.exe", "photoshop.exe", "illustrator.exe", "blender.exe", "aseprite.exe", "mspaint.exe"],
  office: ["winword.exe", "excel.exe", "powerpnt.exe", "wps.exe", "et.exe", "wpp.exe", "obsidian.exe", "notion.exe", "typora.exe"],
  mail: ["outlook.exe", "olk.exe", "thunderbird.exe", "foxmail.exe"],
};

window.APP_ANIMS = {
  music: ["phones_on", "vibe_headphones", "dj_deck"],
  video: ["life_popcorn_catch", "life_tv_remote"],
  game: ["life_video_game"],
  code: ["dev_laptop_front", "dev_hello_world"],
  terminal: ["dev_terminal", "dev_matrix"],
  chat: ["life_phone_call", "dev_ai_chat", "tea_talk"],
  design: ["dev_pixel_editor", "life_paint_easel"],
  office: ["dev_slide_chart", "cos_teacher_chalk"],
  mail: ["dev_inbox_zero", "life_post_letter"],
};

// ------------------------------------------------------------ idle life
//
// When Claude has nothing for it, the pet lives its own life: one scene after another,
// with a short rest in between. A scene is a list of steps played in order. A step is
//   "slug"       looped; the looped steps share the scene's 20-50 seconds
//   ["slug", n]  played exactly n times (entrances, pratfalls)
// Animations that mean "Claude is working" (typing, terminal, thinking...) are kept
// out of here on purpose, so a glance at the pet still tells the two apart.

// How likely each kind of scene is: [while you're using the computer, while it's left alone].
// `routine` comes from the time of day (ROUTINE), `season` from the month, `mood` from
// how it feels (MOODS), `holiday` from today's holiday, `oops` from OOPS, and `surprise`
// is any animation at all. The rest are the keys of LIFE.
window.LIFE_WEIGHTS = {
  routine: [30, 18],
  hobby: [14, 10],
  music: [8, 10],
  sports: [10, 20],
  cosplay: [8, 20],
  chores: [6, 5],
  project: [4, 3],
  season: [10, 10],
  oops: [2, 3],
  surprise: [3, 3],
  mood: [30, 30],
  holiday: [40, 40],
};

window.LIFE = {
  hobby: [
    ["life_paint_easel"],
    ["life_photo_polaroid", "life_selfie"],
    ["life_fishing"],
    ["life_origami_crane"],
    ["life_feed_pet", "life_goldfish"],
    ["bubble_wand", "bubble_big"],
    ["fidget_spinner", "spinner_head"],
    ["life_yoyo", "life_dice_roll"],
    ["life_jigsaw"],
    ["life_knit_scarf"],
    ["life_post_letter"],
    ["life_carrot_pull", "life_water_plant"],
    ["life_video_game"],
    ["life_cookie_jar"],
    ["life_popcorn_catch"],
    ["stairs_climb"],
  ],
  music: [
    ["guitar_rock", "guitar_solo", "rock_jump"],
    ["guitar_chill"],
    ["life_piano"],
    ["life_violin"],
    ["life_drums"],
    [["phones_on", 1], "vibe_headphones", "vibe_nod"],
    ["dj_deck", "dj_vinyl"],
    ["cos_conductor_baton"],
    ["life_karaoke"],
  ],
  sports: [
    // gym
    ["sport_dumbbell_curl", "sport_barbell", "sport_pullups"],
    ["sport_pushups", "sport_squats", "sport_punch_bag"],
    ["sport_treadmill", "sport_rowing_machine", "sport_tire_flip"],
    ["sport_rope_climb"],
    // cardio
    ["sport_jump_rope", "sport_jumping_jacks", "sport_hula_hoop"],
    ["sport_jogging", "sport_cycling"],
    // ball games
    ["soccer_keepy", "soccer_header", "sport_goal_kick", "sport_bicycle_kick"],
    ["sport_goalie_dive"],
    ["sport_ball_spin", "sport_crossover", "sport_dunk"],
    ["sport_ping_pong", "sport_tennis_serve"],
    ["sport_baseball"],
    ["sport_bowling"],
    ["sport_golf_putt"],
    ["sport_frisbee", "sport_dodgeball"],
    // sports day
    ["sport_sprint_start", "sport_hurdles", "sport_finish_line", ["sport_podium", 2]],
    ["sport_high_jump", "sport_shot_put"],
    ["sport_sack_race", "sport_tug_of_war", "sport_pom_poms"],
    // dojo, studio, street
    ["sport_karate_chop", "sport_sumo_stomp", "sport_fencing"],
    ["sport_yoga_tree", "sport_splits", "sport_ballet"],
    ["sport_headspin", "sport_cartwheel", "sport_limbo"],
    ["sport_kickflip", "sport_parkour", "sport_roller_skates"],
    ["sport_unicycle", "sport_juggling", "sport_pogo"],
    ["sport_trampoline"],
    ["sport_archery"],
  ],
  cosplay: [
    // stories
    ["cos_wizard_staff", "cos_wizard_spell", "cos_genie_lamp"],
    ["cos_knight_horse", "cos_knight_shield", "cos_sword_slash", "cos_dragon_fire"],
    ["cos_royal_wave", "cos_royal_knighting", "cos_princess_twirl"],
    ["cos_pirate_spyglass", "cos_sailor_row", "cos_pirate_treasure"],
    ["cos_ninja_dash", "cos_ninja_star"],
    [["cos_hero_change", 1], "cos_hero_fly"],
    ["cos_spy_sneak", "cos_detective_trail"],
    ["cos_cowboy_tumbleweed", "cos_cowboy_lasso"],
    ["cos_scientist_potion", "cos_mad_lightning"],
    ["cos_box_robot", "cos_robot_beep", "cos_mech_pilot"],
    ["cos_dino_roar", "cos_bunny_hop", "cos_frog_tongue"],
    ["cos_angel_flutter", "cos_devil_fork"],
    ["cos_time_travel", "cos_viking_horn", ["cos_time_travel", 1]],
    ["cos_explorer_map", "cos_miner_lamp"],
    ["cos_diver_helmet", "cos_mermaid_splash"],
    ["astro_wave", "astro_float", "astro_spin", "astro_planet", "astro_flag", ["space_drop", 1]],
    ["cos_alien_ufo"],
    // on stage
    ["cos_magician_cards", "cos_magician_hat"],
    ["cos_ringmaster_hoop", "cos_jester_ball"],
    ["cos_mime_box", "cos_puppeteer"],
    // trying out jobs
    ["cos_doctor_stethoscope"],
    ["cos_firefighter_hose"],
    ["cos_lifeguard_ring"],
    ["cos_crossing_guard"],
    ["cos_beekeeper"],
    ["cos_lumberjack_chop"],
    ["cos_pilot_banner"],
    ["cos_mail_delivery"],
    ["hardhat_wrench", "girder_walk", "hardhat_hide"],
  ],
  chores: [
    ["life_sweep_floor", "life_vacuum", "life_feather_duster"],
    ["life_washer_watch", "life_laundry_line", "life_iron_shirt"],
    ["life_wash_dishes", "life_trash_out"],
    ["life_window_wipe"],
    ["life_water_plant"],
  ],
  // Tinkering with a side project of its own.
  project: [
    ["dev_hello_world", "dev_semicolon", "dev_ctrl_s"],
    ["dev_rubber_duck", "dev_step_debug", "dev_bug_squash"],
    ["dev_pixel_editor", "dev_ctrl_z"],
    ["dev_infinite_loop", "dev_cpu_overheat", "dev_reboot"],
    ["dev_refactor", "dev_red_pen"],
    ["dev_log_scroll", "dev_patch_crack"],
    ["dev_key_hop", "dev_cursor_chase"],
    ["dev_sudo", "dev_cloud_upload"],
    ["dev_ai_chat"],
    ["dev_wrench_gear"],
    ["dev_git_blame"],
  ],
};

// Small mishaps, rare.
window.OOPS = [
  ["sport_roller_skates", ["sport_banana_slip", 1], ["emo_dizzy", 3]],
  ["sport_parkour", ["sport_wall_bonk", 1], ["emo_dizzy", 3]],
  [["dev_task_topple", 1], ["emo_awkward", 2]],
  ["sea_windy", ["sea_tornado", 4], ["emo_dizzy", 3]],
  [["life_lemon_sour", 2], ["emo_cringe", 2]],
  ["emo_nervous_sweat", "emo_panic_circles", ["emo_relieved", 2]],
  [["dev_404", 1], ["emo_confused", 2]],
  [["emo_sneeze", 2], ["emo_embarrassed", 2]],
];

// Played once when it starts on that kind of scene (not when it carries on with another one).
window.SCENE_INTRO = { sports: "sport_warmup", cosplay: "teleport" };

// Short beats it throws in between scenes when it's in no particular mood.
window.QUIRKS = ["turn_around", "emo_hiccup", "emo_sneeze", "emo_confused", "idea_ding", "emo_mischief", "emo_giggle", "emo_wink", "stretch_tall", "emo_mind_blown", "emo_mood_swings", "desk_flail", "emo_awe", "emo_jiayou"];

// What the day looks like ("HH:MM", may wrap past midnight). `tilt` multiplies the
// LIFE_WEIGHTS of other kinds of scene during that part of the day.
window.ROUTINE = [
  {
    name: "早晨", from: "06:30", to: "09:00",
    tilt: { sports: 1.4, chores: 1.3, cosplay: 0.6 },
    scenes: [
      ["life_brush_teeth", "life_shower_sing", "life_hair_dryer"],
      ["life_toast_pop", "desk_coffee"],
      ["life_cereal_pour", "life_smoothie_blend"],
      [["chef_arrives", 1], "cook_egg", "cook_pancake"],
      ["sport_warmup", "sport_jogging", "stretch_tall"],
      ["sea_day_night"],
      ["life_water_plant"],
      ["life_window_wipe"],
    ],
  },
  {
    name: "上午", from: "09:00", to: "11:30",
    tilt: { project: 2, sports: 1.2 },
    scenes: [
      ["emo_jiayou", "emo_determined"],
      ["dev_todo"],
      ["dev_inbox_zero"],
      ["dev_slide_chart"],
      ["cos_teacher_chalk"],
      ["read_glasses"],
      ["life_crossword"],
      ["desk_coffee"],
      ["life_post_letter"],
    ],
  },
  {
    name: "午饭", from: "11:30", to: "13:00",
    tilt: { sports: 0.5 },
    scenes: [
      [["chef_arrives", 1], "cook_veggies", "stir_soup", "life_noodle_slurp"],
      ["life_dumpling_steam", "life_wash_dishes"],
      ["life_burger_stack", "life_soda_fizz"],
      ["life_microwave_wait", "life_pizza_munch"],
      ["life_fridge_raid", "life_noodle_slurp"],
      ["life_sushi_belt"],
      ["life_wash_dishes", "life_trash_out"],
      ["life_apple_crunch"],
    ],
  },
  {
    name: "午后", from: "13:00", to: "14:00",
    tilt: { sports: 0.3, music: 0.6, cosplay: 0.6 },
    scenes: [
      [["emo_yawn", 1], "emo_daydream"],
      ["tea_sip"],
      ["life_goldfish", "life_feed_pet"],
      ["emo_meditate"],
      [["armchair_arrive", 1], "read_glasses"],
      ["life_knit_scarf"],
    ],
  },
  {
    name: "下午茶", from: "14:00", to: "16:30",
    tilt: { sports: 1.2 },
    scenes: [
      ["life_boba_straw"],
      ["tea_sip", "tea_talk"],
      ["life_cookie_jar", "life_cake_strawberry"],
      ["life_donut_toss"],
      ["life_jelly_wobble"],
      ["life_smoothie_blend"],
      ["desk_coffee"],
      ["life_apple_crunch"],
    ],
  },
  {
    name: "傍晚", from: "16:30", to: "17:30",
    tilt: { sports: 1.8, chores: 1.3 },
    scenes: [
      ["sport_jogging", "sport_cycling"],
      ["sport_frisbee"],
      ["life_water_plant", "life_carrot_pull"],
      ["life_fishing"],
      ["life_photo_polaroid"],
      ["picnic_basket"],
      ["sea_day_night"],
    ],
  },
  {
    name: "晚饭", from: "17:30", to: "19:30",
    tilt: { sports: 0.5 },
    scenes: [
      ["life_fridge_raid", ["chef_arrives", 1], "cook_veggies", "stir_soup"],
      ["life_dumpling_steam"],
      ["life_sushi_belt"],
      ["life_pizza_munch", "life_soda_fizz"],
      ["life_noodle_slurp", "life_wash_dishes"],
      ["life_burger_stack"],
      ["life_wash_dishes", "life_trash_out"],
    ],
  },
  {
    name: "晚间", from: "19:30", to: "22:30",
    tilt: { music: 1.8, cosplay: 1.4, sports: 0.5, chores: 0.5 },
    scenes: [
      [["walk_in", 1], "life_tv_remote", "life_popcorn_catch"],
      ["life_video_game"],
      ["life_karaoke"],
      [["armchair_arrive", 1], "read_glasses"],
      ["life_jigsaw"],
      ["life_crossword"],
      ["life_knit_scarf"],
      ["life_bubble_bath", "life_hair_dryer"],
      ["sea_telescope", "emo_wish_star"],
      ["life_phone_call"],
    ],
  },
  {
    name: "深夜", from: "22:30", to: "06:30",
    tilt: { sports: 0, chores: 0, music: 0.3, cosplay: 0.4, oops: 0.5 },
    scenes: [
      ["sea_telescope", "emo_wish_star"],
      ["life_fridge_raid"],
      ["sea_hot_cocoa"],
      ["life_brush_teeth", ["emo_yawn", 1]],
      ["emo_meditate"],
      ["read_glasses"],
      [["emo_yawn", 1], "emo_daydream"],
    ],
  },
];

window.SEASONS = {
  spring: [
    ["sea_butterfly_chase", "sea_dandelion"],
    ["sea_umbrella_rain", "sea_puddle_jump", "sea_rainbow"],
    ["life_kite"],
    ["life_carrot_pull", "life_water_plant"],
    ["picnic_basket"],
    ["sea_easter_hunt"],
  ],
  summer: [
    [["shades_drop", 1], "pool_float", "pool_peek"],
    ["sandboard", "surf_wipeout"],
    ["sport_swim_laps", "sport_diving_board", "sport_kayak"],
    ["sea_sandcastle"],
    ["sea_heatwave", "life_icecream_melt"],
    ["life_watermelon_seeds", "life_soda_fizz"],
    ["sea_thunderstorm", "emo_scared"],
    ["sea_fireflies"],
  ],
  autumn: [
    ["sea_rake_leaves", "sea_leaf_pile"],
    ["sea_windy", "sea_fog"],
    ["cos_scarecrow"],
    ["life_knit_scarf", "sea_hot_cocoa"],
    ["sea_telescope"],
    ["picnic_basket"],
  ],
  winter: [
    ["sea_snowman_build", "sea_snowball_fight", "sea_snow_angel"],
    ["sea_ice_skate", "sea_sledding"],
    ["sea_hot_cocoa", "sea_fireplace"],
    ["sea_snow_globe"],
    ["sea_hail", ["emo_sneeze", 2]],
  ],
};

window.seasonOf = (date) => ["winter", "spring", "summer", "autumn"][Math.floor(((date.getMonth() + 1) % 12) / 3)];

// Moods colour its idle life for a while: `rest` replaces ANIMS.idle between scenes,
// `scenes` join the draw with the `mood` weight, and an optional `tilt` works like the
// one in ROUTINE. What sets each mood off is in pet.js.
window.MOODS = {
  happy: {
    label: "心情不错",
    rest: ["vibe_nod", "bubble_wand", "tea_sip"],
    scenes: [["emo_happy_skip", "emo_victory_dance"], ["emo_hyper_bounce"], ["emo_giggle", "emo_laugh_roll"], ["emo_excited_vibrate", "emo_joy_burst"]],
  },
  proud: {
    label: "得意洋洋",
    rest: ["emo_proud_chest", "emo_smug_shades"],
    scenes: [["emo_smug_shades", "emo_proud_chest"], ["sport_podium"], ["emo_victory_dance"]],
  },
  loved: {
    label: "被宠着",
    rest: ["emo_shy", "cos_cat_purr", "emo_self_hug"],
    scenes: [["emo_lovestruck", "emo_heart_pound"], ["emo_shy", "emo_embarrassed"], ["emo_blow_kiss"], ["cos_cat_purr"]],
  },
  bored: {
    label: "有点无聊",
    rest: ["emo_bored_sigh", "emo_daydream", "fidget_spinner", "turn_around"],
    scenes: [["emo_bored_sigh", "fidget_spinner", "spinner_head"], ["turn_around", "emo_daydream"], ["life_dice_roll"], ["life_yoyo"], ["dev_cursor_chase"], ["bubble_wand", "bubble_big"]],
  },
  lonely: {
    label: "有点想你",
    rest: ["emo_lonely", "life_goldfish", "emo_self_hug", "emo_daydream"],
    scenes: [["emo_lonely", "emo_self_hug"], ["turn_around", "emo_sad_shuffle"], ["life_phone_call"], ["life_post_letter"], ["emo_wish_star"], ["life_goldfish", "life_feed_pet"], ["emo_sulk_cloud"]],
  },
  grumpy: {
    label: "闹脾气",
    rest: ["emo_grumpy_pout", "emo_puffed_cheeks"],
    scenes: [["emo_boiling", "emo_calm_down"], ["emo_eye_roll", "emo_grumpy_pout"], ["emo_jealous"], ["sport_punch_bag"]],
  },
  down: {
    label: "有点郁闷",
    rest: ["emo_gloom", "emo_sulk_cloud"],
    scenes: [["emo_sulk_cloud", "emo_sad_shuffle"], ["emo_calm_down", "emo_meditate"], ["emo_comfort"], ["dev_rubber_duck"]],
  },
  sleepy: {
    label: "犯困",
    tilt: { sports: 0, oops: 0, cosplay: 0.3, music: 0.3, chores: 0.5 },
    rest: ["emo_daydream", "emo_meditate"],
    scenes: [[["emo_yawn", 1], "emo_daydream"], ["sea_hot_cocoa"], ["life_bubble_bath"], ["read_glasses"]],
  },
};

// Never picked as a random "surprise": they'd be mistaken for a real state.
window.NOT_FOR_FUN = ["life_bed_sleep", "read_doze", ...window.ANIMS.dreamNight, ...window.ANIMS.dreamNap, "dev_bsod", "emo_pretty_please", "emo_impatient", "walk_out_door", "dev_thinking"];

// Small talk at fixed times ("HH:MM"), once a day.
window.NUDGES = [
  { at: "12:00", say: "到饭点啦，先去吃饭吧～", anims: ["life_noodle_slurp", "life_burger_stack", "life_dumpling_steam"] },
  { at: "15:30", say: "下午茶时间，喝口水歇一歇～", anims: ["life_boba_straw", "tea_sip"] },
  { at: "18:30", say: "该吃晚饭啦～", anims: ["cook_veggies", "life_sushi_belt"] },
];

// ------------------------------------------------------------ holidays

const XMAS = ["sea_tree_star", "sea_santa_sack", "sea_reindeer_bells", "sea_fireplace", "sea_gingerbread_chase", "sea_gift_unwrap", "sea_snow_globe"];
const HALLOWEEN = ["sea_pumpkin_carve", "sea_ghost_sheet", "sea_trick_treat", "sea_witch_broom", "sea_mummy_wrap", "sea_vampire_cape", "sea_skeleton_dance", "sea_bats_circle"];
const SPRING_FESTIVAL = ["sea_red_envelope", "sea_lion_dance", "sea_firecracker", "sea_fu_upside", "sea_fireworks_watch"];

const FIXED_HOLIDAYS = {
  "01-01": { name: "元旦", say: "新年快乐！", anims: ["sea_fireworks_watch", "sea_party_popper", "sea_countdown"] },
  "02-14": { name: "情人节", say: "情人节快乐～", anims: ["sea_valentine_balloon", "emo_blow_kiss", "life_window_wipe"] },
  "04-01": { name: "愚人节", say: "今天说的话可不能全信哦～", anims: ["emo_mischief", "cos_jester_ball", "cos_magician_hat"] },
  "06-01": { name: "儿童节", say: "儿童节快乐，大朋友！", anims: ["bubble_big", "life_yoyo", "cos_bunny_hop", "life_kite"] },
  "10-24": { name: "程序员节", say: "1024 程序员节快乐！", anims: ["dev_hello_world", "dev_matrix", "dev_contrib_graph"] },
  "10-31": { name: "万圣节", say: "不给糖就捣蛋！", anims: HALLOWEEN },
  "12-24": { name: "平安夜", say: "平安夜快乐～", anims: XMAS },
  "12-25": { name: "圣诞节", say: "圣诞快乐！", anims: XMAS },
  "12-31": { name: "跨年夜", say: "今年最后一天啦，辛苦了！", anims: ["sea_countdown", "sea_fireworks_watch", "sea_party_popper"] },
};

// Lunar festivals as solar dates. A table rather than Intl's Chinese calendar,
// which is a day off around some new moons (e.g. Spring Festival 2027).
const LUNAR_DATES = {
  2026: { springFestival: "02-17", lantern: "03-03", duanwu: "06-19", qixi: "08-19", midAutumn: "09-25" },
  2027: { springFestival: "02-06", lantern: "02-20", duanwu: "06-09", qixi: "08-08", midAutumn: "09-15" },
  2028: { springFestival: "01-26", lantern: "02-09", duanwu: "05-28", qixi: "08-26", midAutumn: "10-03" },
  2029: { springFestival: "02-13", lantern: "02-27", duanwu: "06-16", qixi: "08-16", midAutumn: "09-22" },
  2030: { springFestival: "02-03", lantern: "02-17", duanwu: "06-05", qixi: "08-05", midAutumn: "09-12" },
};

const LUNAR_HOLIDAYS = {
  lantern: { name: "元宵节", say: "元宵节快乐，吃汤圆了吗？", anims: ["sea_sky_lantern", "sea_fireworks_watch"] },
  duanwu: { name: "端午节", say: "端午安康！", anims: ["sea_dragon_boat"] },
  qixi: { name: "七夕", say: "七夕快乐～", anims: ["sea_sparkler_heart", "sea_valentine_balloon", "emo_lovestruck"] },
  midAutumn: { name: "中秋节", say: "中秋快乐，记得吃月饼～", anims: ["sea_mooncake_moon", "sea_sky_lantern"] },
};

const monthDay = (d) => `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** Holidays on `date`: [{ name, say, anims }]. `birthday` is "MM-DD" or empty. */
window.holidaysOn = function holidaysOn(date, birthday) {
  const md = monthDay(date);
  const out = [];
  if (birthday && birthday === md) {
    out.push({ name: "生日", say: "生日快乐！🎂", anims: ["sea_birthday_candles", "sea_party_popper", "sea_gift_unwrap"] });
  }
  if (FIXED_HOLIDAYS[md]) out.push(FIXED_HOLIDAYS[md]);

  const lunar = LUNAR_DATES[date.getFullYear()];
  if (lunar) {
    for (const [key, holiday] of Object.entries(LUNAR_HOLIDAYS)) {
      if (lunar[key] === md) out.push(holiday);
    }
    // New Year's Eve, then the first week of the new year.
    const [m, d] = lunar.springFestival.split("-").map(Number);
    const days = Math.round((new Date(date.getFullYear(), date.getMonth(), date.getDate()) - new Date(date.getFullYear(), m - 1, d)) / 86400000);
    if (days === -1) out.push({ name: "除夕", say: "除夕快乐，年夜饭吃起来！", anims: ["life_dumpling_steam", "sea_fu_upside", "sea_firecracker"] });
    if (days >= 0 && days <= 6) out.push({ name: "春节", say: "新春快乐，恭喜发财！🧧", anims: SPRING_FESTIVAL });
  }
  return out;
};
