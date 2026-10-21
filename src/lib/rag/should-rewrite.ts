export function shouldRewriteQuery(
    query: string,
    history: Array<{
        role: 'user' | 'assistant';
        content: string;
    }>,
): boolean {
    // 没有历史对话，不需要改写
    if(!history.length) {
        return false;
    }

    const text = query.trim();

    if(!text) {
        return false;
    }

    // 明显依赖上下文的指代词
    const referenceWords = [
        '它',
        '这个',
        '那个',
        '这些',
        '那些',
        '他',
        '她',
        '他们',
        '上面',
        '刚才',
        '之前',
        '前面',
        '上述',
    ];

    if(referenceWords.some(word => text.includes(word))) {
        return true;
    }

    // 明显依赖上一轮语境的短问题
    const contextDependentPatterns = [
        /^那/,
        /^然后/,
        /^接下来/,
        /^还有呢/,
        /^为什么/,
        /^怎么做/,
        /^怎么办/,
        /^有什么区别/,
        /^有什么不同/,
        /^具体怎么/,
        /^具体是什么/,
        // 序号引用：第二条、第二种、第3点……
        /第[一二三四五六七八九十\d]+[条种个点步类项]/,
        /还有(其他|别的)/,
        /怎么解决/,
        /会这样/,
    ];

    if(contextDependentPatterns.some(pattern => pattern.test(text))) {
        return true;
    }

    return false;
}