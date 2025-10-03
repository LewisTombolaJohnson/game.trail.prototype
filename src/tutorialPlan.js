// Tutorial plan for the first 8 days before transitioning from Carnival to Jungle.
// This file provides a structured, data-driven way to script deterministic outcomes
// (dice rolls, landing levels, forced rewards) overriding the normal random systems.
// Later we can extend each day with popup text scripts, conditional branches, etc.
// Initial authored path (example). Adjust targetLevel numbers to match your actual board layout.
// The idea: introduce short moves, small guaranteed rewards, a first minigame, then ramp a little.
export const TUTORIAL_DAYS = [
    {
        day: 1,
        forcedDice: 4,
        targetLevel: 5,
        reward: { kind: 'minigame', minigame: 'lootbox', forceLootboxAmount: 50, forceLootboxKind: 'bonus', notes: 'Fixed starter 50p bonus to demonstrate bonus currency.' },
        autoTriggerCategory: true,
        overrideZone: 'carnival',
        designerNotes: 'Introduce movement + UI.',
        popups: {
            start_day: [
                "<p>Welcome to tombola trails! I’m Tom, your guide to this world!</p>",
                "<p>Before I forget, here is your daily dice, you can roll this every day to move through the world and earn rewards, why not give it a try?</p>"
            ],
            post_move: [
                "<p>You moved onto your first tile!</p>",
                "<p>Looks like you collected some tokens, every step you take will give you a token, once you get X, you can play a bonus game!</p>",
                "<p>You’ve landed on a minigame, lets see what it is!</p>",
            ],
            pre_minigame: [
                "<p>Ah, a mystery box, why not tap and see whats inside?</p>"
            ],
            post_minigame: [
                "<p>That’s a cool prize. It looks like you also found a key! You can collect keys every consecutive day you play and when you have 30 you can open the treasure vault. I’ve heard there are some great riches to be had. Be warned however, that skipping a day will cause all keys to be destroyed!</p>",
                "<p>You also found a prize star! You can collect a single prize star each day, and when you have 5 you will win a prize. Don’t worry about losing these, they won’t reset even if you miss a day!</p>",
                "<p>That’s everything for today. But before you go, if you want a sneak peek of what’s coming up you can look further ahead by scrolling.</p>"
            ]
        }
    },
    {
        day: 2,
        forcedDice: 6,
        targetLevel: 11,
        // Award 2 free plays explicitly on day 2
        reward: { kind: 'freePlays', amount: 2, notes: 'Two Free Plays to showcase multi-award.' },
        overrideZone: 'carnival',
        designerNotes: 'Highlight progress & level nodes.',
        popups: {
            start_day: "<p>Welcome back {PLAYER_NAME} it’s great to see you! Ready to see what prizes await today?</p>",
            post_move: "<p>Looks like you’ve landed on an instant win space, let’s see what your prize is shall we?</p>",
            post_instantwin: [
                "<p>Way to go! Another prize and another star, it won’t be long until you have 5! Remember that 5 stars grants a prize!</p>",
                "<p>Since you’re down by the water, why not try one of our water themed games? Oh, and don’t forget to continue the adventure tomorrow!</p>"
            ],
        }
    },
    {
        day: 3,
        forcedDice: 3,
        targetLevel: 14,
        reward: { kind: 'bonus', notes: 'Introduce bonus round concept.' },
        overrideZone: 'carnival',
        forceLandingCategory: 'bonus_round',
        designerNotes: 'Introduce concept of prizes.',
        popups: {
            start_day: "<p>Hey again partner! You don’t mind me calling you that right? See that box on the path? That’s a bonus game, wouldn’t it be cool if we landed on it?</p>",
            post_move: "<p>You did it! Time for a bonus round! In this game it’s just you vs the banker!</p>",
            post_bonus_round: [
                "<p>Whew, that was fun! Bonus games are great ways to receive bigger wins! Don’t forget your key and prize star too</p>",
                "<p>This isn’t the only place you can play Deal or No Deal. If you enjoyed that, why not check out our other Deal or No Deal games</p>"
            ]
        }
    },
    {
        day: 4,
        forcedDice: 1,
        targetLevel: 15,
        reward: { kind: 'minigame', minigame: 'slot', forceSlotSymbol: '⭐', notes: 'Force open slot after landing (tutorial explanation). Guaranteed win via forced symbols.' },
        overrideZone: 'carnival',
        forceLandingCategory: 'mystery',
        designerNotes: 'Teach minigame basics.',
        popups: {
            start_day: [
                "<p>Welcome back, let’s get to rolling shall we?</p>",
                "<p>Is that, a mystery space ahead?</p>"
            ],
            post_move: "<p>This is a mystery square, you won’t know what it is until you land on it! Let’s hope we get lucky! We'll see you tomorrow no matter the reward I hope!</p>",
        }
    },
    {
        day: 5,
        forcedDice: 4,
        targetLevel: 19,
        reward: { kind: 'tokens', amount: 15, notes: 'Bump token amount; show resource utility soon.' },
        overrideZone: 'carnival',
        designerNotes: 'Escalating token reward.',
        popups: {
            start_day: "<p>It’s your 5th day, you know what that means? Collecting a prize star today will give you a reward!</p>",
            post_instantwin: [
                "<p>It’s your 5th prize star!</p>",
                "<p>Wow, way to go! Remember, you receive prize star prizes every 5th day, so why not start collecting stars again tomorrow?</p>"
            ],
        }
    },
    {
        day: 6,
        forcedDice: 3,
        targetLevel: 22,
        reward: { kind: 'minigame', minigame: 'spin_wheel', notes: 'Demonstrate spin wheel fairness/visuals.' },
        overrideZone: 'carnival',
        designerNotes: 'Spin Wheel intro.',
        popups: {
            start_day: "<p>Hey! Hope you're ready to win some prizes!</p>",
            post_roll: "<p>You’ve landed on a movement space! Looks like the journey doesn’t stop here!</p>",
            post_move: "<p>Looks like a mini game!</p>",
            post_minigame: "<p>Thats a lot of tokens today, just a few more and you will be able to redeem them for a bonus game!</p>"
        }
    },
    {
        day: 7,
        forcedDice: 5,
        targetLevel: 27,
        reward: { kind: 'tokens', amount: 20, notes: 'Escalation before finale; sets up for loot box preview.' },
        overrideZone: 'carnival',
        designerNotes: 'Pre-finale build-up.',
        popups: {
            start_day: "<p>Hi again! We’re still so close to having enough tokens for a bonus game!</p>",
            post_move: "<p>Let’s hope we get a good token prize! Only X to go!</p>",
            post_minigame: "<p>You’ve done it! Looks like it’s time for a bonus game!</p>"
        }
    },
    {
        day: 8,
        forcedDice: 3,
        targetLevel: 30,
        reward: { kind: 'minigame', minigame: 'lootbox', forceLootboxKind: 'cash', forceLootboxAmount: 100, notes: 'Showcase guaranteed cash reel outcome before transition.' },
        overrideZone: 'carnival',
        transitionAfter: true,
        designerNotes: 'Finale + transition.',
        popups: {
            start_day: "<p>Welcome back! Yesterday was exciting and I have a feeling today will be too!</p>",
            post_minigame: "<p>You’ve reached the end of the zone! Looks like a new adventure awaits</p>"
        }
    }
];
export function isTutorialActive(currentDay) {
    return currentDay >= 1 && currentDay <= 8;
}
export function getTutorialPlanForDay(day) {
    return TUTORIAL_DAYS.find(d => d.day === day);
}
// Registration helper so main.ts can import and enqueue popups automatically without manual queue calls.
export function registerTutorialPopups(enqueue) {
    TUTORIAL_DAYS.forEach(plan => {
        if (!plan.popups)
            return;
        Object.entries(plan.popups).forEach(([phase, value]) => {
            if (!value)
                return;
            if (Array.isArray(value))
                value.forEach(v => enqueue(plan.day, phase, v));
            else
                enqueue(plan.day, phase, value);
        });
    });
}
//# sourceMappingURL=tutorialPlan.js.map