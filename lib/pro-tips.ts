const proTips = [
  "Describe the card's job, like \"removal for big creatures\" or \"cheap ramp\".",
  "Mention the format you play, like Commander, Modern, or Pauper.",
  "Include creature types in plain English, like \"goblins\" or \"angels\".",
  "Call out mechanics in words, like \"lifelink\" or \"sacrifice a creature\".",
  "Say what the card should do on ETB, draw, or combat.",
  "If results feel broad, add one more detail like color, cost, or type.",
  "If results feel narrow, remove extra adjectives and try again.",
  "Describe the art you want, like \"dragon in a storm\" or \"sword in the sky\".",
  "You can search for themes like tokens, counters, or graveyard synergies.",
  "Try asking for combos, like \"cards that copy spells\" or \"double damage\".",
  "Use examples in your prompt, like \"a card like Lightning Bolt\".",
  "Search for roles like finisher, value engine, or protection.",
  "You can tweak the Scryfall query by editing the text in the query box.",
  "id:g means the card contains green; id=g means the card is exactly green.",
  "Use quotes for exact phrases, like \"enter the battlefield\".",
  "Add \"is:commander\" to find commanders, or \"legal:modern\" for formats.",
  "Use \"type:\" to filter types, like type:dragon or type:artifact.",
  "Combine filters with AND by default, like \"type:creature cmc<=3\".",
  "Use \"o:\" to search rules text, like o:\"draw a card\".",
  "Try \"pow>=4\" and \"tou>=4\" to find big creatures.",
  "Add \"rarity:mythic\" or \"rarity:uncommon\" to narrow results.",
  "Use \"c:\" for color identity, like c:wu for Azorius cards.",
  "Use \"set:khm\" or \"set:one\" to limit to a specific set.",
  "Add \"t:legendary\" to find legendary permanents.",
  "Use \"mana>=4\" to find cards with bigger mana costs.",
  "Try \"tag:\" to search Scryfall community tags, like tag:removal.",
  "Use \"-\" to exclude terms, like \"type:creature -type:human\"."
];

export const getRandomProTip = () => {
  if (proTips.length === 0) {
    return "";
  }
  const index = Math.floor(Math.random() * proTips.length);
  return proTips[index];
};
