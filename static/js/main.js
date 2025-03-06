let network = null;
let currentGraphId = null;
let loadingInterval;
let abortController = null;
let isGenerating = false;
let dotCount = 0;  // 添加到文件开头的全局变量
let currentLoadingMessage = null;
let lastGeneratedTopic = null;
let lastGeneratedCount = null;
let customFontLoaded = false;

// 标识当前图谱是否为新增概念生成的图谱（默认 false）
window.isNewConceptGraph = false; 
// 用来记录新增概念场景下上一轮用于 LLM 生成的请求数据，例如：{ topic:"xxx", count:10, ... }
window.lastAddedConceptRequest = null;

document.addEventListener('DOMContentLoaded', function() {
    const generateBtn = document.getElementById('generate-btn');
    const topicInput = document.getElementById('topic-input');
    const infoBox = document.getElementById('info-box');
    const progressContainer = document.querySelector('.progress-container');
    const progressBar = document.querySelector('.progress-bar');
    const decreaseBtn = document.getElementById('decrease');
    const increaseBtn = document.getElementById('increase');
    const conceptCount = document.getElementById('concept-count');
    const likeBtn = document.getElementById('like-btn');
    const dislikeBtn = document.getElementById('dislike-btn');
    const feedbackButtons = document.querySelector('.feedback-buttons');

    // 预加载字体
    const font = new FontFace('NotoSansHans-Bold', 'url(/static/css/NotoSansHans-Bold.otf)');
    font.load().then(() => {
        document.fonts.add(font);
        customFontLoaded = true;
    }).catch(err => {
        console.error('字体加载失败:', err);
        customFontLoaded = false;
    });

    generateBtn.addEventListener('click', function() {
        if (isGenerating) {
            if (abortController) {
                abortController.abort();
                isGenerating = false;
                generateBtn.textContent = '生成图谱';
                infoBox.textContent = '生成已中止';
                progressContainer.style.display = 'none';
                progressBar.style.width = '0%';
                // 清理加载动画定时器
                if (loadingInterval) {
                    clearInterval(loadingInterval);
                    loadingInterval = null;
                }
                // 重置按钮状态
                likeBtn.disabled = false;
                dislikeBtn.disabled = false;
                generateBtn.disabled = false;
                // 隐藏图谱编号显示
                document.getElementById('graph-id-display').style.display = 'none';
            }
        } else {
            const currentTopic = topicInput.value.trim();
            const currentCount = parseInt(conceptCount.value);
            
            // 修改这部分逻辑，确保在生成新图谱时清除之前的新增概念请求数据
            if (currentTopic === lastGeneratedTopic && currentCount === lastGeneratedCount) {
                // 如果主题和概念数量都没变，执行重新生成逻辑
                if (window.isNewConceptGraph) {
                    // 如果是新增概念后的图谱，使用新增概念的重新生成逻辑
                    sendFeedback(false);
                } else {
                    // 如果不是新增概念后的图谱，使用普通的重新生成逻辑
                    generateNetwork();
                }
            } else {
                // 生成新图谱时，重置新增概念相关的标记
                window.isNewConceptGraph = false;
                window.lastAddedConceptRequest = null;
                generateNetwork();
                lastGeneratedTopic = currentTopic;
                lastGeneratedCount = currentCount;
            }
        }
    });

    decreaseBtn.addEventListener('click', () => {
        const currentValue = parseInt(conceptCount.value);
        if (currentValue > 5) {
            conceptCount.value = currentValue - 1;
        }
    });

    increaseBtn.addEventListener('click', () => {
        const currentValue = parseInt(conceptCount.value);
        if (currentValue < 20) {
            conceptCount.value = currentValue + 1;
        }
    });

    function updateProgress(progress, message) {
        // 如果已经因过滤而停止，则不更新进度信息
        if (window.stopGeneration) return;
        
        progressBar.style.width = `${progress}%`;
        
        const loadingMessages = [
            "正在分析节点关系...\n节点太多的话可能需时几分钟",
            "正在初始化...\n接下来可能需要几分钟",
            "正在初始化新增节点流程",
            "正在生成新节点详细描述",
            "正在合并节点",
            "正在生成网络数据"
        ];
        
        // 修改这部分逻辑，避免消息闪烁
        if (loadingMessages.includes(message)) {
            // 如果是加载消息，但与当前显示的消息不同，才重置定时器
            if (currentLoadingMessage !== message) {
                // 清除现有定时器
                if (loadingInterval) {
                    clearInterval(loadingInterval);
                }
                
                // 设置新的当前消息和初始点数
                currentLoadingMessage = message;
                dotCount = 0;
                
                // 立即显示初始消息（无点）
                infoBox.textContent = message;
                
                // 创建新的定时器
                loadingInterval = setInterval(function() {
                    dotCount = (dotCount + 1) % 4;
                    const dots = '.'.repeat(dotCount);
                    // 更新时也判断一下停止标记
                    if (!window.stopGeneration) {
                        // 只更新点数部分，避免整个消息闪烁
                        infoBox.textContent = message + dots;
                        infoBox.scrollTop = infoBox.scrollHeight;
                    }
                }, 300); // 每0.3秒更新一次
            }
            // 如果消息相同，不做任何处理，让现有定时器继续工作
        } else {
            // 对于非加载状态信息，先清除定时器（如果已存在）
            if (loadingInterval) {
                clearInterval(loadingInterval);
                loadingInterval = null;
                currentLoadingMessage = null;
            }
            // 直接显示消息，不添加省略号
            if (!window.stopGeneration) {
                infoBox.textContent = message;
                infoBox.scrollTop = infoBox.scrollHeight;
            }
        }
    }

    async function sendFeedback(isLike) {
        if (isGenerating) {
            if (abortController) {
                abortController.abort();
                isGenerating = false;
                generateBtn.textContent = '生成图谱';
                infoBox.textContent = '生成已中止';
                progressContainer.style.display = 'none';
                progressBar.style.width = '0%';
                if (loadingInterval) {
                    clearInterval(loadingInterval);
                    loadingInterval = null;
                }
                likeBtn.disabled = false;
                dislikeBtn.disabled = false;
                generateBtn.disabled = false;
                document.getElementById('graph-id-display').style.display = 'none';
                document.getElementById('download-btn').style.display = 'none';
            }
        }

        try {
            let topic, count, requestData = {};
            if (!isLike) {
                console.log("window.lastAddedConceptRequest:", window.lastAddedConceptRequest);
                console.log("lastGeneratedTopic:", lastGeneratedTopic);
                
                // 在开始重新生成前，先显示加载状态到 info-box
                infoBox.textContent = '正在重新生成图谱...';
                progressContainer.style.display = 'block';
                progressBar.style.width = '0%';
                
                if (window.isNewConceptGraph && window.lastAddedConceptRequest && window.lastAddedConceptRequest.topic) {
                    // 只有在确实是新增概念图谱的情况下才使用 lastAddedConceptRequest
                    requestData = {
                        ...window.lastAddedConceptRequest,
                        is_new_concept: true,
                        added_concept_data: {
                            ...window.lastAddedConceptRequest,
                            regenerate: true
                        }
                    };
                    topic = requestData.topic;
                    count = requestData.count;
                } else {
                    // 使用普通的重新生成逻辑
                    topic = lastGeneratedTopic;
                    count = lastGeneratedCount;
                }
                
                // 重新生成之前先检查过滤词
                const isFiltered = await loadAndCheckFilters(topic);
                if (isFiltered) {
                    alert('抱歉，这不是我擅长的主题，问我点别的吧！');
                    // 清理图谱显示及相关控件
                    if (network) {
                        network.destroy();
                        network = null;
                    }
                    document.getElementById('network').innerHTML = '';
                    feedbackButtons.style.display = 'none';
                    document.getElementById('download-btn').style.display = 'none';
                    document.getElementById('graph-id-display').style.display = 'none';
                    document.getElementById('search-graph-btn').style.display = 'block';
                    infoBox.textContent = "抱歉，这不是我擅长的主题，问我点别的吧！";
                    return;
                }
                
                isGenerating = true;
                abortController = new AbortController();
                generateBtn.textContent = "生成中，点击中止";
                generateBtn.disabled = false;
                document.getElementById('network-loading').style.display = 'flex';
                likeBtn.disabled = false;
                dislikeBtn.disabled = false;
            } else {
                likeBtn.disabled = true;
                dislikeBtn.disabled = false;
                topic = topicInput.value.trim();
                count = parseInt(conceptCount.value);
                abortController = new AbortController();
            }
            
            if (!topic || !count) {
                throw new Error('主题或概念数量不能为空');
            }
            
            const response = await fetch('/feedback', {
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json',
                    'Cache-Control': 'no-cache'
                },
                body: JSON.stringify({
                    topic: topic,
                    count: count,
                    graph_id: currentGraphId,
                    is_like: isLike,
                    ...requestData
                }),
                signal: abortController.signal
            });

            console.log('Response headers:', {
                contentType: response.headers.get('content-type'),
                transferEncoding: response.headers.get('transfer-encoding'),
                connection: response.headers.get('connection')
            });

            const contentType = response.headers.get("content-type");
            // 检查是否是SSE响应且是分块传输的
            const isRealSSE = contentType && contentType.includes("text/event-stream") && 
                             (response.headers.get("transfer-encoding") === "chunked" || 
                              !response.headers.get("content-length"));
            
            if (isRealSSE) {
                const reader = response.body.getReader();
                const decoder = new TextDecoder();
                let buffer = ''; // 添加缓冲区来处理分片数据

                while (true) {
                    const { value, done } = await reader.read();
                    if (done) {
                        console.log('Stream completed');
                        break;
                    }
                    
                    // 将新数据添加到缓冲区
                    buffer += decoder.decode(value, { stream: true });
                    
                    // 尝试按行分割并处理完整的 JSON 对象
                    let lines;
                    if (buffer.includes("\n\n")) {
                        // 标准SSE格式，使用双换行符分割
                        lines = buffer.split('\n\n');
                    } else if (buffer.includes("\n")) {
                        // 可能是单行JSON，使用单换行符分割
                        lines = buffer.split('\n');
                    } else {
                        // 无法分割，等待更多数据
                        continue;
                    }
                    
                    // 保留最后一个可能不完整的行
                    buffer = lines.pop() || '';
                    
                    console.log('Processing lines:', lines);
                    
                    for (let line of lines) {
                        if (!line.trim()) continue;
                        
                        // 标准 SSE 消息会以 "data:" 开头，所以去除这个前缀
                        if (line.startsWith("data:")) {
                            line = line.slice(5).trim();
                        }

                        try {
                            const data = JSON.parse(line);
                            console.log('Successfully parsed data:', data);
                            
                            if (data.status === 'error') {
                                throw new Error(data.message);
                            }
                            
                            updateProgress(data.progress, data.message);
                            
                            if (data.status === 'complete' && data.data) {
                                if (loadingInterval) {
                                    clearInterval(loadingInterval);
                                    loadingInterval = null;
                                    currentLoadingMessage = null;
                                }
                                currentGraphId = data.data.graph_id;
                                updateGraphIdDisplay(currentGraphId);
                                feedbackButtons.style.display = 'flex';
                                searchGraphBtn.style.display = 'block';
                                createNetwork(data.data.network_data);
                                document.getElementById('download-btn').style.display = 'block';
                                
                                setTimeout(() => {
                                    progressContainer.style.display = 'none';
                                    progressBar.style.width = '0%';
                                    infoBox.textContent = '点击节点查看详细信息，图谱可缩放及下载';
                                }, 500);
                            }
                        } catch (parseError) {
                            console.error('Parse error for line:', line);
                            console.error('Parse error details:', parseError);
                            
                            // 检查是否是过滤内容
                            if (line.includes("[[CONTENT_FILTERED]]")) {
                                window.stopGeneration = true;
                                await reader.cancel("过滤内容检测到，提前终止");
                                throw new Error("抱歉，这不是我擅长的主题，问我点别的吧！");
                            }
                        }
                    }
                }
                
                // 处理缓冲区中剩余的数据
                if (buffer.trim()) {
                    try {
                        const data = JSON.parse(buffer);
                        console.log('Processing final buffer data:', data);
                        
                        if (data.status === 'complete' && data.data) {
                            currentGraphId = data.data.graph_id;
                            updateGraphIdDisplay(currentGraphId);
                            feedbackButtons.style.display = 'flex';
                            searchGraphBtn.style.display = 'block';
                            createNetwork(data.data.network_data);
                            document.getElementById('download-btn').style.display = 'block';
                            
                            setTimeout(() => {
                                progressContainer.style.display = 'none';
                                progressBar.style.width = '0%';
                                infoBox.textContent = '点击节点查看详细信息，图谱可缩放及下载';
                            }, 500);
                        }
                    } catch (parseError) {
                        console.error('Error parsing final buffer:', parseError);
                    }
                }
                
            } else {
                // 非 SSE 响应处理，或者是Apache环境下content-type错误的情况
                const responseText = await response.text();
                console.log('Full response text:', responseText);
                
                try {
                    const data = JSON.parse(responseText);
                    console.log('Parsed response data:', data);
                    
                    if (data.error) {
                        throw new Error(data.error);
                    }
                    
                    if (data.data) {
                        currentGraphId = data.data.graph_id;
                        updateGraphIdDisplay(currentGraphId);
                        createNetwork(data.data.network_data);
                        document.getElementById('download-btn').style.display = 'block';
                        feedbackButtons.style.display = 'flex';
                        
                        setTimeout(() => {
                            progressContainer.style.display = 'none';
                            progressBar.style.width = '0%';
                            infoBox.textContent = '点击节点查看详细信息，图谱可缩放及下载';
                        }, 500);
                    }
                } catch (parseError) {
                    console.error('JSON parse error:', parseError);
                    console.error('Response text that failed to parse:', responseText);
                    throw parseError;
                }
            }
        } catch (error) {
            console.error('Feedback error:', error);
            if (error.name === 'AbortError') {
                infoBox.textContent = '生成已中止';
            } else {
                infoBox.textContent = '生成失败，请重试';
            }
            progressContainer.style.display = 'none';
            progressBar.style.width = '0%';
            document.getElementById('download-btn').style.display = 'none';
        } finally {
            isGenerating = false;
            generateBtn.textContent = '生成图谱';
            // 对于点赞反馈保持 likeBtn 禁用状态；重新生成反馈则恢复
            if (!isLike) {
                likeBtn.disabled = false;
            }
            dislikeBtn.disabled = false;
            if (abortController) {
                abortController = null;
            }
            document.getElementById('network-loading').style.display = 'none';
        }
    }

    likeBtn.addEventListener('click', () => sendFeedback(true));
    dislikeBtn.addEventListener('click', () => sendFeedback(false));

    // 添加关键词过滤功能
    async function loadAndCheckFilters(topic) {
        try {
            const response = await fetch('/check_filter', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ topic: topic })
            });
            const data = await response.json();
            return data.filtered;
        } catch (error) {
            return false;
        }
    }

    async function generateNetwork() {
        // 开始前先清除之前的定时器，避免老的定时器继续更新 infoBox 和进度条
        if (loadingInterval) {
            clearInterval(loadingInterval);
            loadingInterval = null;
            currentLoadingMessage = null;
        }
        // 重置停止标记
        window.stopGeneration = false;
        
        const topic = topicInput.value.trim();
        const count = parseInt(conceptCount.value);
        
        if (!topic) {
            alert('请输入主题');
            return;
        }
        
        // 在生成之前检查过滤词
        const isFiltered = await loadAndCheckFilters(topic);
        if (isFiltered) {
            alert('抱歉，这不是我擅长的主题，问我点别的吧！');
            return;
        }
        
        isGenerating = true;
        abortController = new AbortController();
        
        generateBtn.textContent = "生成中，点击中止";
        
        // 显示 loading 层
        document.getElementById('network-loading').style.display = 'flex';
        
        try {
            progressContainer.style.display = 'block';
            // 重置相关按钮状态
            likeBtn.disabled = false;
            dislikeBtn.disabled = false;
            
            const response = await fetch('/generate_stream?t=' + new Date().getTime(), {
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json',
                    'Cache-Control': 'no-cache'
                },
                body: JSON.stringify({ topic: topic, count: count }),
                signal: abortController.signal
            });

            // 输出响应头信息，方便排查反向代理与 SSE 流问题
            console.log('Response headers:', {
                contentType: response.headers.get('content-type'),
                transferEncoding: response.headers.get('transfer-encoding'),
                connection: response.headers.get('connection')
            });

            const contentType = response.headers.get("content-type");
            if (contentType && contentType.includes("text/event-stream")) {
                if (network) {
                    network.destroy();
                    network = null;
                }
                document.getElementById('network').innerHTML = '';
                infoBox.textContent = '正在生成新的图谱...';
                
                progressContainer.style.display = 'block';
                feedbackButtons.style.display = 'none';
    
                const reader = response.body.getReader();
                const decoder = new TextDecoder();
                let buffer = '';  // 利用 buffer 累加分片数据

                while (true) {
                    const { value, done } = await reader.read();
                    if (done) {
                        console.log('Stream completed');
                        break;
                    }
                    
                    // 累加当前读取的数据
                    buffer += decoder.decode(value, { stream: true });
                    
                    // 按换行符分割，注意服务器需确保每个完整 JSON 对象后都输出一个换行符
                    const lines = buffer.split('\n');
                    // 保留最后一个可能不完整的部分
                    buffer = lines.pop() || '';
                    
                    console.log('Processing lines:', lines);
                    
                    for (let line of lines) {
                        if (!line.trim()) continue;

                        // 标准 SSE 消息会以 "data:" 开头，所以去除这个前缀
                        if (line.startsWith("data:")) {
                            line = line.slice(5).trim();
                        }
                        
                        try {
                            const data = JSON.parse(line);
                            console.log('Parsed data:', data);
                            
                            if (data.status === 'error') {
                                throw new Error(data.message);
                            }
                            
                            updateProgress(data.progress, data.message);
                            
                            if (data.status === 'complete' && data.data) {
                                if (loadingInterval) {
                                    clearInterval(loadingInterval);
                                    loadingInterval = null;
                                    currentLoadingMessage = null;
                                }
                                currentGraphId = data.data.graph_id;
                                updateGraphIdDisplay(currentGraphId);
                                feedbackButtons.style.display = 'flex';
                                searchGraphBtn.style.display = 'block';
                                createNetwork(data.data.network_data);
                                document.getElementById('download-btn').style.display = 'block';
                                
                                setTimeout(() => {
                                    progressContainer.style.display = 'none';
                                    progressBar.style.width = '0%';
                                    infoBox.textContent = '点击节点查看详细信息，图谱可缩放及下载';
                                }, 500);
                            }
                        } catch (parseError) {
                            console.error('Parse error:', parseError, 'for line:', line);
                            // 如果发现过滤标记，则及时终止
                            if (line.includes("[[CONTENT_FILTERED]]")) {
                                window.stopGeneration = true;
                                await reader.cancel("过滤内容检测到，提前终止");
                                infoBox.textContent = "抱歉，这不是我擅长的主题，问我点别的吧！";
                                
                                document.getElementById('graph-id-display').style.display = 'none';
                                document.getElementById('search-graph-btn').style.display = 'block';
                                if (network) {
                                    network.destroy();
                                    network = null;
                                }
                                document.getElementById('network').innerHTML = '';
                                feedbackButtons.style.display = 'none';
                                document.getElementById('download-btn').style.display = 'none';
                                progressContainer.style.display = 'none';
                                progressBar.style.width = '0%';
                                return;
                            }
                            // 若解析错误就跳过此行并等待后续数据补全
                        }
                    }
                }
            } else {
                // 非 SSE 响应处理
                const responseText = await response.text();
                console.log('Non-SSE response text:', responseText);
                
                try {
                    const data = JSON.parse(responseText);
                    console.log('Parsed JSON response:', data);
                    
                    if (data.error) {
                        throw new Error(data.error);
                    }
                    
                    if (data.data) {
                        currentGraphId = data.data.graph_id;
                        updateGraphIdDisplay(currentGraphId);
                        createNetwork(data.data.network_data);
                        document.getElementById('download-btn').style.display = 'block';
                        feedbackButtons.style.display = 'flex';
                    }
                } catch (error) {
                    console.error('JSON parse error:', error);
                    throw error;
                }
            }
        } catch (error) {
            console.error('Network or processing error:', error);
            if (error.message.includes("这不是我擅长的主题")) {
                infoBox.textContent = error.message;
                if (network) {
                    network.destroy();
                    network = null;
                }
                document.getElementById('network').innerHTML = '';
                feedbackButtons.style.display = 'none';
                searchGraphBtn.style.display = 'none';
                document.getElementById('download-btn').style.display = 'none';
                progressContainer.style.display = 'none';
                progressBar.style.width = '0%';
            } else {
                infoBox.textContent = '生成失败，请重试';
            }
            progressContainer.style.display = 'none';
            progressBar.style.width = '0%';
        } finally {
            isGenerating = false;
            generateBtn.textContent = '生成图谱';
            if (abortController) {
                abortController = null;
            }
            document.getElementById('network-loading').style.display = 'none';
        }
    }

    function createNetwork(data) {
        const container = document.getElementById('network');
        
        if (network) {
            network.destroy();
        }

        const options = {
            nodes: {
                shape: 'dot',
                size: 25,
                font: {
                    size: 14,
                    face: 'NotoSansHans-Regular',
                    multi: true
                }
            },
            edges: {
                arrows: {
                    to: {
                        enabled: true,
                        scaleFactor: 1
                    }
                },
                font: {
                    size: 12,
                    face: 'NotoSansHans-Regular'
                },
                smooth: {
                    type: 'curvedCW',
                    roundness: 0.2
                },
                width: 2
            },
            physics: {
                barnesHut: {
                    gravitationalConstant: -30000,
                    springLength: 150,
                    springConstant: 0.04,
                    centralGravity: 0.3,
                    damping: 0.09
                }
            },
            interaction: {
                zoomView: true,
                dragView: true,
                multiselect: false
            }
        };

        network = new vis.Network(
            container,
            {
                nodes: new vis.DataSet(data.nodes),
                edges: new vis.DataSet(data.edges)
            },
            options
        );

        const nodes = network.body.data.nodes;
        const edges = network.body.data.edges;
        
        const originalColors = {};
        data.nodes.forEach(node => {
            originalColors[node.id] = node.color.background;
        });

        network.on('click', function(params) {
            if (params.nodes.length > 0) {
                const selectedNode = params.nodes[0];
                const connectedNodes = new Set();
                
                edges.get().forEach(edge => {
                    if (edge.from === selectedNode) {
                        connectedNodes.add(edge.to);
                    }
                    if (edge.to === selectedNode) {
                        connectedNodes.add(edge.from);
                    }
                });
                
                nodes.get().forEach(node => {
                    const originalColor = originalColors[node.id];
                    if (node.id === selectedNode || connectedNodes.has(node.id)) {
                        nodes.update({
                            id: node.id,
                            color: {
                                background: originalColor,
                                highlight: {
                                    background: originalColor
                                }
                            }
                        });
                    } else {
                        const desaturatedColor = tinycolor(originalColor).desaturate(100).toString();
                        nodes.update({
                            id: node.id,
                            color: {
                                background: desaturatedColor,
                                highlight: {
                                    background: originalColor
                                }
                            }
                        });
                    }
                });

                const node = data.nodes.find(n => n.id === selectedNode);
                if (node && node.explanation) {
                    infoBox.textContent = node.explanation;
                }
            } else {
                nodes.get().forEach(node => {
                    const originalColor = originalColors[node.id];
                    nodes.update({
                        id: node.id,
                        color: {
                            background: originalColor,
                            highlight: {
                                background: originalColor
                            }
                        }
                    });
                });
                infoBox.textContent = '点击节点查看详细信息，图谱可缩放及下载';
            }
        });

        let touchTimeout;
        network.on("touchstart", function(params) {
            touchTimeout = setTimeout(function() {
                if (params.nodes.length > 0) {
                    const nodeId = params.nodes[0];
                    const node = data.nodes.find(n => n.id === nodeId);
                    if (node && node.explanation) {
                        infoBox.textContent = node.explanation;
                    }
                }
            }, 500);
        });

        network.on("touchend", function() {
            clearTimeout(touchTimeout);
        });

        network.once('stabilizationIterationsDone', function() {
            network.fit({
                animation: {
                    duration: 1000,
                    easingFunction: 'easeInOutQuad'
                }
            });
        });
    }

    // 更新图谱编号显示的辅助函数
    function updateGraphIdDisplay(id) {
        const graphIdElem = document.getElementById('graph-id-value');
        if (graphIdElem) {
            graphIdElem.textContent = id;
            // 生成完成后显示图谱编号区域
            document.getElementById('graph-id-display').style.display = 'block';
        }
    }

    // 添加加载默认图谱的函数
    async function loadDefaultGraph() {
        try {
            document.getElementById('network-loading').style.display = 'flex';
            const response = await fetch('/default_graph');
            const data = await response.json();
            
            if (data.error) {
                throw new Error(data.error);
            }
    
            if (data.data) {
                currentGraphId = data.data.graph_id;
                // 默认图谱加载时不显示图谱编号
                document.getElementById('graph-id-display').style.display = 'none';
                createNetwork(data.data.network_data);
                // 不显示反馈按钮
                feedbackButtons.style.display = 'none';
                infoBox.textContent = '点击节点查看详细信息，图谱可缩放及下载';
            } else {
                throw new Error("没有收到图谱数据");
            }
        } catch (error) {
            infoBox.textContent = '默认图谱加载失败: ' + error.message;
        } finally {
            document.getElementById('network-loading').style.display = 'none';
        }
    }

    // 添加从URL获取参数的函数
    function getUrlParameter(name) {
        name = name.replace(/[\[]/, '\\[').replace(/[\]]/, '\\]');
        var regex = new RegExp('[\\?&]' + name + '=([^&#]*)');
        var results = regex.exec(location.search);
        return results === null ? '' : decodeURIComponent(results[1].replace(/\+/g, ' '));
    }

    // 页面加载时检查URL中是否有graph_id参数
    const graphIdFromUrl = getUrlParameter('graph_id');
    if (graphIdFromUrl) {
        // 如果URL中有graph_id参数，则加载指定图谱
        searchGraphFromUrl(graphIdFromUrl);
    } else {
        // 没有参数时加载默认图谱
        loadDefaultGraph();
    }

    // 添加从URL加载图谱的函数
    async function searchGraphFromUrl(graphId) {
        try {
            document.getElementById('network-loading').style.display = 'flex';
            infoBox.textContent = '正在加载指定图谱...';
            
            const response = await fetch('/search_graph', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ 
                    graph_id: graphId
                })
            });
            const data = await response.json();
            
            if (data.error) {
                throw new Error(data.error);
            }
            
            if (data.data) {
                currentGraphId = data.data.graph_id;
                updateGraphIdDisplay(currentGraphId);
                
                // 缓存当前图谱的主题和概念数量，用于"重新生成"
                lastGeneratedTopic = data.data.topic;
                lastGeneratedCount = data.data.concept_count;

                feedbackButtons.style.display = 'flex';
                searchGraphBtn.style.display = 'block';
                createNetwork(data.data.network_data);
                document.getElementById('download-btn').style.display = 'block';
                infoBox.textContent = '点击节点查看详细信息，图谱可缩放及下载';
            }
        } catch (error) {
            infoBox.textContent = '加载图谱失败：' + error.message;
        } finally {
            document.getElementById('network-loading').style.display = 'none';
        }
    }

    // 新增概念相关控件
    const addConceptBtn = document.getElementById('add-concept-btn');
    const modalOverlay = document.getElementById('modal-overlay');
    const confirmAddConceptBtn = document.getElementById('confirm-add-concept');
    const cancelAddConceptBtn = document.getElementById('cancel-add-concept');
    const newConceptInput = document.getElementById('new-concept-input');

    // 点击"新增概念"按钮时显示模态弹窗及遮罩
    addConceptBtn.addEventListener('click', () => {
        modalOverlay.style.display = 'flex';
    });

    // 点击"取消"按钮关闭弹窗
    cancelAddConceptBtn.addEventListener('click', () => {
        modalOverlay.style.display = 'none';
        newConceptInput.value = '';
    });

    // 点击"新增"按钮提交新概念
    confirmAddConceptBtn.addEventListener('click', async () => {
        const newConcept = newConceptInput.value.trim();
        if (!newConcept) {
            alert('请输入新概念/人物');
            return;
        }
        modalOverlay.style.display = 'none';
        newConceptInput.value = '';
        
        // 记录当前图谱作为基础图谱（未进行融合前的图谱A）
        const baseGraphId = currentGraphId;
        
        document.getElementById('network-loading').style.display = 'flex';
        infoBox.textContent = '正在新增概念';
        
        // 显示进度条
        progressContainer.style.display = 'block';
        progressBar.style.width = '0%';
        
        // 设置生成状态和中止控制器
        isGenerating = true;
        abortController = new AbortController();
        generateBtn.textContent = "生成中，点击中止";
        
        try {
            const topic = topicInput.value.trim();
            const currentCount = parseInt(conceptCount.value);
            const response = await fetch('/add_concept', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    graph_id: currentGraphId,
                    new_concept: newConcept
                }),
                signal: abortController.signal
            });

            // 输出调试用的响应头信息
            console.log('Add concept response headers:', {
                contentType: response.headers.get('content-type'),
                transferEncoding: response.headers.get('transfer-encoding'),
                connection: response.headers.get('connection')
            });

            const contentType = response.headers.get("content-type");

            if (contentType && contentType.includes("text/event-stream")) {
                const reader = response.body.getReader();
                const decoder = new TextDecoder();
                let buffer = '';  // 用来累加可能被分块的 SSE 数据

                while (true) {
                    const { value, done } = await reader.read();
                    if (done) {
                        console.log('Add concept stream completed');
                        break;
                    }

                    // 累加当前读取的数据，注意使用 stream:true 以便正确处理分块
                    buffer += decoder.decode(value, { stream: true });

                    // 按 "\n\n" 来分割完整的 SSE 消息
                    const segments = buffer.split('\n\n');
                    // 将最后一个可能不完整的片段留在 buffer 中，等待后续数据继续拼接
                    buffer = segments.pop() || '';

                    // 处理拆分出来的每一段完整 SSE 数据
                    for (let segment of segments) {
                        if (!segment.trim()) continue;

                        // 标准 SSE 消息一般以 "data:" 开头，去掉该前缀
                        if (segment.startsWith("data:")) {
                            segment = segment.slice(5).trim();
                        }

                        // 解析 JSON
                        try {
                            const data = JSON.parse(segment);
                            console.log('Add concept parsed data:', data); // 解析后数据的调试日志

                            // 若后端返回错误状态，抛出异常交由外层捕获
                            if (data.status === 'error') {
                                throw new Error(data.message);
                            }

                            // 更新进度条
                            if (data.progress !== undefined) {
                                progressBar.style.width = `${data.progress}%`;
                            }
                            if (data.message) {
                                updateProgress(data.progress, data.message);
                            }

                            // 如果状态为 complete，且有 data 字段，代表生成成功
                            if (data.status === 'complete' && data.data) {
                                currentGraphId = data.data.graph_id;
                                updateGraphIdDisplay(currentGraphId);
                                feedbackButtons.style.display = 'flex';
                                likeBtn.disabled = false;
                                dislikeBtn.disabled = false;
                                searchGraphBtn.style.display = 'block';
                                createNetwork(data.data.network_data);
                                document.getElementById('download-btn').style.display = 'block';

                                setTimeout(() => {
                                    progressContainer.style.display = 'none';
                                    progressBar.style.width = '0%';
                                    infoBox.textContent = '点击节点查看详细信息，图谱可缩放及下载';
                                }, 500);

                                // 设置新增概念标记
                                window.isNewConceptGraph = true;
                                window.lastAddedConceptRequest = {
                                    topic: topic,
                                    count: currentCount,
                                    new_concept: newConcept,
                                    base_graph_id: baseGraphId
                                };
                            }
                        } catch (parseError) {
                            console.error('Add concept parse error:', parseError, 'for segment:', segment);

                            // 检测到内容过滤标记或其它异常时，主动报错中断
                            if (segment.includes("[[CONTENT_FILTERED]]")) {
                                throw new Error("抱歉，这不是我擅长的主题，问我点别的吧！");
                            }
                            throw parseError;
                        }
                    }
                }
            } else {
                // 如果后端不是 SSE 返回，则按普通 JSON 处理
                const responseText = await response.text();
                console.log('Add concept non-SSE response:', responseText);

                try {
                    const data = JSON.parse(responseText);
                    console.log('Add concept parsed JSON response:', data);

                    if (data.error) {
                        throw new Error(data.error);
                    }
                    if (data.data) {
                        currentGraphId = data.data.graph_id;
                        updateGraphIdDisplay(currentGraphId);
                        createNetwork(data.data.network_data);
                        document.getElementById('download-btn').style.display = 'block';
                        window.lastAddedConceptRequest = {
                            topic: topic,
                            count: currentCount,
                            new_concept: newConcept,
                            base_graph_id: baseGraphId
                        };
                        infoBox.textContent = '点击节点查看详细信息，图谱可缩放及下载';
                    } else {
                        throw new Error("没有收到图谱数据");
                    }
                } catch (error) {
                    console.error('Add concept JSON parse error:', error);
                    throw error;
                }
            }
        } catch (error) {
            console.error('Add concept network or processing error:', error);

            // 判断是否是被中断
            if (error.name === 'AbortError') {
                infoBox.textContent = '生成已中止';
            } else {
                infoBox.textContent = '新增节点失败，请重试';
            }
        } finally {
            isGenerating = false;
            generateBtn.textContent = '生成图谱';
            if (abortController) {
                abortController = null;
            }
            document.getElementById('network-loading').style.display = 'none';
            progressContainer.style.display = 'none';
            progressBar.style.width = '0%';
            likeBtn.disabled = false;
            dislikeBtn.disabled = false;
        }
    });

    // 为复制图谱编号添加事件监听
    document.getElementById('copy-icon').addEventListener('click', function() {
        const graphId = document.getElementById('graph-id-value').innerText;
        if (graphId && graphId !== '未生成') {
            navigator.clipboard.writeText(graphId).then(() => {
                alert('图谱编号已复制到剪贴板');
            }).catch((err) => {
                alert('复制失败，请重试');
            });
        }
    });

    // 新增搜寻图谱相关变量和事件监听
    const searchGraphBtn = document.getElementById('search-graph-btn');
    const modalSearchOverlay = document.getElementById('modal-overlay-search');
    const confirmSearchGraphBtn = document.getElementById('confirm-search-graph');
    const cancelSearchGraphBtn = document.getElementById('cancel-search-graph');
    const searchGraphInput = document.getElementById('search-graph-input');

    searchGraphBtn.addEventListener('click', () => {
        modalSearchOverlay.style.display = 'flex';
    });

    cancelSearchGraphBtn.addEventListener('click', () => {
        modalSearchOverlay.style.display = 'none';
        searchGraphInput.value = '';
    });

    confirmSearchGraphBtn.addEventListener('click', async () => {
        const graphIdToSearch = searchGraphInput.value.trim();
        if (!graphIdToSearch) {
            alert('请输入图谱编号');
            return;
        }
        // 关闭模态弹窗并清空输入框
        modalSearchOverlay.style.display = 'none';
        searchGraphInput.value = '';

        // 显示加载遮罩和提示信息
        document.getElementById('network-loading').style.display = 'flex';
        infoBox.textContent = '正在搜寻图谱';
        
        // 显示进度条
        progressContainer.style.display = 'block';
        progressBar.style.width = '0%';
        
        // 设置生成状态和中止控制器
        isGenerating = true;
        abortController = new AbortController();
        generateBtn.textContent = "生成中，点击中止";
        
        try {
            const response = await fetch('/search_graph', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ 
                    graph_id: graphIdToSearch
                }),
                signal: abortController.signal
            });

            // 添加响应头调试信息
            console.log('Search graph response headers:', {
                contentType: response.headers.get('content-type'),
                transferEncoding: response.headers.get('transfer-encoding'),
                connection: response.headers.get('connection')
            });

            const contentType = response.headers.get("content-type");
            if (contentType && contentType.includes("text/event-stream")) {
                const reader = response.body.getReader();
                const decoder = new TextDecoder();

                while (true) {
                    const { value, done } = await reader.read();
                    if (done) {
                        console.log('Search graph stream completed');
                        break;
                    }
                    
                    const lines = decoder.decode(value).split('\n');
                    console.log('Search graph received chunk:', lines); // 添加数据块调试信息
                    
                    for (let line of lines) {
                        if (!line.trim()) continue;
                        
                        try {
                            const data = JSON.parse(line);
                            console.log('Search graph parsed data:', data); // 添加解析后数据调试信息
                            
                            if (data.status === 'error') {
                                throw new Error(data.message);
                            }

                            // 更新进度条和消息
                            if (data.progress !== undefined) {
                                progressBar.style.width = `${data.progress}%`;
                            }
                            if (data.message) {
                                updateProgress(data.progress, data.message);
                            }
                            
                            if (data.status === 'complete' && data.data) {
                                currentGraphId = data.data.graph_id;
                                updateGraphIdDisplay(currentGraphId);
                                // 同时显示反馈按钮和搜寻图谱按钮（保持"保存图片"的显示状态一致）
                                feedbackButtons.style.display = 'flex';
                                searchGraphBtn.style.display = 'block';
                                createNetwork(data.data.network_data);
                                // 图谱生成成功后显示下载按钮
                                document.getElementById('download-btn').style.display = 'block';
                                setTimeout(() => {
                                    progressContainer.style.display = 'none';
                                    progressBar.style.width = '0%';
                                    infoBox.textContent = '点击节点查看详细信息，图谱可缩放及下载';
                                }, 500);
                            }
                        } catch (parseError) {
                            console.error('Search graph parse error:', parseError, 'for line:', line);
                            if (line.includes("[[CONTENT_FILTERED]]")) {
                                throw new Error("抱歉，这不是我擅长的主题，问我点别的吧！");
                            }
                            throw parseError;
                        }
                    }
                }
            } else {
                console.log('Search graph non-SSE response received:', contentType);
                const responseText = await response.text();
                console.log('Search graph response text:', responseText);
                
                try {
                    const data = JSON.parse(responseText);
                    console.log('Search graph parsed JSON response:', data);
                    
                    if (data.error) {
                        throw new Error(data.error);
                    }
                    
                    if (data.data) {
                        currentGraphId = data.data.graph_id;
                        updateGraphIdDisplay(currentGraphId);
                        // 同时显示反馈按钮和搜寻图谱按钮（保持"保存图片"的显示状态一致）
                        feedbackButtons.style.display = 'flex';
                        searchGraphBtn.style.display = 'block';
                        createNetwork(data.data.network_data);
                        // 图谱生成成功后显示下载按钮
                        document.getElementById('download-btn').style.display = 'block';
                        setTimeout(() => {
                            progressContainer.style.display = 'none';
                            progressBar.style.width = '0%';
                            infoBox.textContent = '点击节点查看详细信息，图谱可缩放及下载';
                        }, 500);
                        // 缓存当前图谱的主题和概念数量，用于"重新生成"
                        lastGeneratedTopic = data.data.topic;
                        lastGeneratedCount = data.data.concept_count;
                    } else {
                        throw new Error("没有收到图谱数据");
                    }
                } catch (error) {
                    console.error('Search graph JSON parse error:', error);
                    throw error;
                }
            }
        } catch (error) {
            console.error('Search graph network or processing error:', error);
            if (error.name === 'AbortError') {
                infoBox.textContent = '搜寻已中止';
            } else {
                infoBox.textContent = '没能找到图谱，请重试';
            }
            progressContainer.style.display = 'none';
            progressBar.style.width = '0%';
        } finally {
            isGenerating = false;
            generateBtn.textContent = '生成图谱';
            generateBtn.disabled = false;
            likeBtn.disabled = false;
            dislikeBtn.disabled = false;
            if (abortController) {
                abortController = null;
            }
            document.getElementById('network-loading').style.display = 'none';
        }
    });

    // 在页面加载时，检查 URL 参数并加载数据
    function loadGraphDataFromUrl() {
        const urlParams = new URLSearchParams(window.location.search);
        const graphId = urlParams.get('graph_id');
        if (graphId) {
            // 调用后端接口获取graph_id对应的图谱详细数据
            fetch('/get_graph?graph_id=' + graphId, {
                method: 'GET',
                headers: { 'Cache-Control': 'no-cache' }
            })
            .then(response => {
                if (!response.ok) {
                    throw new Error('获取图谱数据失败');
                }
                return response.json();
            })
            .then(data => {
                console.log('Loaded graph data:', data);
                // 假设返回数据格式为： { topic: "xxx", conceptCount: 5, network_data: {...} }
                if (data.topic) {
                    topicInput.value = data.topic;
                }
                if (data.conceptCount) {
                    conceptCount.value = data.conceptCount;
                }
                // 如果后端返回了现有图谱数据，也可直接展示
                if (data.network_data) {
                    createNetwork(data.network_data);
                    // 如果需要，也可以提示用户这是已存在的图谱
                    infoBox.textContent = '当前图谱加载成功，可点击"重新生成"重新生成图谱';
                }
            })
            .catch(err => {
                console.error('加载 graph_id 数据失败:', err);
            });
        }
    }

    // 页面加载时调用
    window.addEventListener('load', loadGraphDataFromUrl);

    // 添加二维码弹出功能
    const feedbackLink = document.getElementById('feedback-link');
    if (feedbackLink) {
        feedbackLink.addEventListener('click', function(e) {
            e.preventDefault();
            
            // 创建弹出层
            const qrOverlay = document.createElement('div');
            qrOverlay.className = 'qr-overlay';
            
            // 创建二维码图片
            const qrImage = document.createElement('img');
            qrImage.src = '/static/images/qr.jpg';
            qrImage.className = 'qr-image';
            qrImage.alt = '反馈二维码';
            
            // 添加到页面
            qrOverlay.appendChild(qrImage);
            document.body.appendChild(qrOverlay);
            
            // 点击弹出层任意位置关闭
            qrOverlay.addEventListener('click', function() {
                document.body.removeChild(qrOverlay);
            });
        });
    }
});

document.getElementById('download-btn').addEventListener('click', async function() {
    if (!network) return;
    
    // 保存当前视图状态和每个节点原始字体设置
    const originalScale = network.getScale();
    const originalPosition = network.getViewPosition();
    const originalNodes = network.body.data.nodes.get();
    const originalFontMap = {};
    originalNodes.forEach(node => {
        originalFontMap[node.id] = node.font ? { ...node.font } : { size: 14, face: 'NotoSansHans-Regular' };
    });
    
    // 调用 network.fit() 使所有节点显示在视图中
    network.fit({ animation: false });
    
    // 根据节点数量动态调整节点字体放大倍数
    let fontMultiplier = 1.5;  // 默认放大倍数
    const nodeCount = originalNodes.length;
    if (nodeCount < 10) {
        if (nodeCount < 5) {
            fontMultiplier = 1.2;
        } else {
            fontMultiplier = 1.1;
        }
    }
    
    // 临时调整节点字体
    const newNodes = originalNodes.map(node => {
        let currentFont = node.font || { size: 14, face: 'NotoSansHans-Regular' };
        return { id: node.id, font: { ...currentFont, size: currentFont.size * fontMultiplier } };
    });
    network.body.data.nodes.update(newNodes);
    network.redraw();
    
    // 获取当前网络的 canvas（内部截图使用的 canvas）
    const networkCanvas = document.getElementsByTagName('canvas')[0];
    if (!networkCanvas) return;
    
    // 创建截图用的画布，高倍数保证清晰度
    const screenshotCanvas = document.createElement('canvas');
    const screenshotCtx = screenshotCanvas.getContext('2d');
    const scaleFactor = 2; // 放大倍数
    screenshotCanvas.width = networkCanvas.width * scaleFactor;
    screenshotCanvas.height = networkCanvas.height * scaleFactor;
    
    // 绘制白色背景
    screenshotCtx.fillStyle = '#ffffff';
    screenshotCtx.fillRect(0, 0, screenshotCanvas.width, screenshotCanvas.height);
    // 缩放上下文以匹配放大倍数
    screenshotCtx.scale(scaleFactor, scaleFactor);
    
    // 获取网络截图的图片数据
    const dataUrl = networkCanvas.toDataURL('image/png', 1.0);
    const img = new Image();
    img.onload = function() {
        // 将网络图绘制到截图画布上
        screenshotCtx.drawImage(img, 0, 0);
        
        // 裁切四周白色部分，保留最小尺寸为 800×800
        const croppedCanvas = cropWhite(screenshotCanvas, 800, 800);
        const cropW = croppedCanvas.width;
        const cropH = croppedCanvas.height;
        
        // 定义边框尺寸：
        // 上、左、右均为裁剪后图片宽度的 5%，下为裁剪后图片高度的 12%
        const borderLeft = Math.round(0.03 * cropW);
        const borderTop = Math.round(0.03 * cropW);
        const borderRight = borderLeft;
        const borderBottom = Math.round(0.12 * cropH);
        
        // 最终图片尺寸
        const finalWidth = cropW + borderLeft + borderRight;
        const finalHeight = cropH + borderTop + borderBottom;
        const finalCanvas = document.createElement('canvas');
        finalCanvas.width = finalWidth;
        finalCanvas.height = finalHeight;
        const finalCtx = finalCanvas.getContext('2d');
        
        // 填充整个画布背景为外描边颜色 #00a99d
        finalCtx.fillStyle = '#00a99d';
        finalCtx.fillRect(0, 0, finalWidth, finalHeight);
        
        // 将裁切后的图片绘制到新画布内，居于边框内部
        finalCtx.drawImage(croppedCanvas, borderLeft, borderTop);
        
        // 文本处理：
        // 在下方边框中，左侧位于裁剪后图片宽度的 5% 处写上 "TermsAI"
        // 字体高度设置为裁剪后图片高度的 9%，并加粗
        const textFontSize = Math.round(0.09 * cropH);
        
        // 使用已加载的字体或后备字体
        if (customFontLoaded) {
            finalCtx.font = `${textFontSize}px 'NotoSansHans-Bold'`;
        } else {
            finalCtx.font = `${textFontSize}px Arial`;
        }
        finalCtx.fillStyle = '#ffffff';
        finalCtx.textBaseline = 'middle';
        const textX = borderLeft;
        const textY = borderTop + cropH + borderBottom / 2;
        finalCtx.fillText("TermsAI", textX, textY);
        
        // 二维码处理：
        // 最终二维码高度（及宽度）为裁剪后图片高度的 9%
        const finalQrSize = Math.round(0.09 * cropH);
        const graphId = currentGraphId;
        // 使用较大尺寸生成二维码以便后续缩小
        const genQrSize = 200;
        const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=${genQrSize}x${genQrSize}&data=${window.location.origin}/?graph_id=${graphId}`;
        const qrImg = new Image();
        qrImg.crossOrigin = "Anonymous";
        qrImg.onload = function(){
            // 在生成二维码后添加外描边处理：
            const qrPadding = Math.round(genQrSize * 0.1); // 10% 的边距
            const qrCanvasSize = genQrSize + 2 * qrPadding;
            const qrCanvas = document.createElement('canvas');
            qrCanvas.width = qrCanvasSize;
            qrCanvas.height = qrCanvasSize;
            const qrCtx = qrCanvas.getContext('2d');
            
            // 填充背景为白色
            qrCtx.fillStyle = '#ffffff';
            qrCtx.fillRect(0, 0, qrCanvasSize, qrCanvasSize);
            // 绘制二维码图像在中间
            qrCtx.drawImage(qrImg, qrPadding, qrPadding, genQrSize, genQrSize);
            // 绘制外描边，颜色为 #00a99d
            const borderLineWidth = Math.max(2, Math.round(qrCanvasSize * 0.05));
            qrCtx.lineWidth = borderLineWidth;
            qrCtx.strokeStyle = '#00a99d';
            qrCtx.strokeRect(borderLineWidth/2, borderLineWidth/2, qrCanvasSize - borderLineWidth, qrCanvasSize - borderLineWidth);
            
            // 将包含描边的二维码缩小到最终二维码尺寸
            const scaledQrCanvas = document.createElement('canvas');
            scaledQrCanvas.width = finalQrSize;
            scaledQrCanvas.height = finalQrSize;
            const scaledQrCtx = scaledQrCanvas.getContext('2d');
            scaledQrCtx.drawImage(qrCanvas, 0, 0, qrCanvas.width, qrCanvas.height, 0, 0, finalQrSize, finalQrSize);
            
            // 将二维码放置在下方边框中，靠右侧
            const qrX = finalWidth - borderRight - finalQrSize;
            const qrY = borderTop + cropH + (borderBottom - finalQrSize) / 2;
            finalCtx.drawImage(scaledQrCanvas, qrX, qrY, finalQrSize, finalQrSize);
            
            // 在二维码左侧添加说明文字
            const qrTextFontSize = Math.round(textFontSize / 3); // TermsAI 字号的 1/3
            finalCtx.font = qrTextFontSize + "px 'Noto Sans S Chinese'"; // 不加粗
            finalCtx.fillStyle = '#ffffff';
            finalCtx.textAlign = 'right'; // 右对齐
            finalCtx.textBaseline = 'middle';
            
            // 计算文字位置：二维码左侧 1% 裁剪后图片宽度的距离
            const qrTextX = qrX - Math.round(0.01 * cropW);
            const qrTextY = qrY + finalQrSize / 2; // 垂直居中对齐二维码
            
            // 绘制两行文字
            const lines = ['扫码查看', '说人话的知识图谱'];
            const lineHeight = qrTextFontSize * 1.2; // 行高为字号的 1.2 倍
            lines.forEach((line, index) => {
                finalCtx.fillText(line, qrTextX, qrTextY + (index - 0.5) * lineHeight);
            });
            
            // 替换原有的下载代码，改为显示预览
            const previewOverlay = document.createElement('div');
            previewOverlay.className = 'preview-overlay';
            
            const previewImage = document.createElement('img');
            previewImage.src = finalCanvas.toDataURL('image/png');
            previewImage.className = 'preview-image';
            
            previewOverlay.appendChild(previewImage);
            document.body.appendChild(previewOverlay);
            
            // 点击非图片区域关闭预览
            previewOverlay.addEventListener('click', function(e) {
                if (e.target === previewOverlay) {
                    document.body.removeChild(previewOverlay);
                }
            });
            
            // 恢复用户原来的视图和节点原始字体设置
            network.moveTo({
                position: originalPosition,
                scale: originalScale,
                animation: false
            });
            const restoreNodes = originalNodes.map(node => {
                return { id: node.id, font: originalFontMap[node.id] || undefined };
            });
            network.body.data.nodes.update(restoreNodes);
            network.redraw();
        };
        qrImg.src = qrUrl;
    };
    img.src = dataUrl;
});

/**
 * 裁切给定画布中四周的白色边缘部分，
 * 保证裁切区域的最小宽高不低于 minWidth 和 minHeight（单位为像素）。
 */
function cropWhite(canvas, minWidth, minHeight) {
    const ctx = canvas.getContext('2d');
    const width = canvas.width;
    const height = canvas.height;
    const imgData = ctx.getImageData(0, 0, width, height);
    const data = imgData.data;
    let top = null, left = null, right = null, bottom = null;
    
    // 遍历所有像素，寻找非白色区域的边界（这里将白色判定为 R=G=B=255）
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const idx = (y * width + x) * 4;
            const r = data[idx], g = data[idx + 1], b = data[idx + 2];
            if (!(r === 255 && g === 255 && b === 255)) {
                if (top === null) {
                    top = y;
                }
                if (left === null || x < left) {
                    left = x;
                }
                if (right === null || x > right) {
                    right = x;
                }
                bottom = y;
            }
        }
    }
    
    // 如果整个画布均为白色，则直接返回原画布
    if (top === null) {
        return canvas;
    }
    
    // 计算裁切区域尺寸，并保证最小宽高不低于给定值
    let cropWidth = right - left + 1;
    let cropHeight = bottom - top + 1;
    if (cropWidth < minWidth) {
        const extra = minWidth - cropWidth;
        left = Math.max(0, left - Math.floor(extra / 2));
        right = Math.min(width - 1, right + Math.ceil(extra / 2));
        cropWidth = right - left + 1;
    }
    if (cropHeight < minHeight) {
        const extra = minHeight - cropHeight;
        top = Math.max(0, top - Math.floor(extra / 2));
        bottom = Math.min(height - 1, bottom + Math.ceil(extra / 2));
        cropHeight = bottom - top + 1;
    }
    
    const croppedCanvas = document.createElement('canvas');
    croppedCanvas.width = cropWidth;
    croppedCanvas.height = cropHeight;
    const croppedCtx = croppedCanvas.getContext('2d');
    croppedCtx.drawImage(canvas, left, top, cropWidth, cropHeight, 0, 0, cropWidth, cropHeight);
    return croppedCanvas;
}
