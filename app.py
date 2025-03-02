from flask import Flask, render_template, request, jsonify, Response, make_response, stream_with_context
from utils import generate_concepts, generate_relationships, create_network_data, parse_json_response, generate_new_concept_detail
from database import DatabaseManager
from models import Session, KnowledgeGraph  # 新增获取图谱所需
import json
import uuid
import re
import time
import os
import logging

app = Flask(__name__)

# 确保日志目录存在
log_dir = '/var/log/termsai'
if not os.path.exists(log_dir):
    os.makedirs(log_dir, exist_ok=True)

# 配置日志
logging.basicConfig(
    filename='/var/log/termsai/app.log',
    level=logging.DEBUG,
    format='%(asctime)s %(levelname)s: %(message)s'
)

@app.route('/')
def index():
    # 为新用户生成UUID
    if 'user_id' not in request.cookies:
        user_id = str(uuid.uuid4())
        response = make_response(render_template('index.html'))
        response.set_cookie('user_id', user_id, max_age=31536000, secure=True, httponly=True)  # 1年有效期
        return response
    return render_template('index.html')

@app.route('/generate_stream', methods=['POST'])
def generate_stream():
    topic = request.json.get('topic')
    count = request.json.get('count', 10)
    
    if not topic:
        return jsonify({'error': '请输入主题'}), 400
    if not 5 <= count <= 20:
        return jsonify({'error': '概念数量必须在5到20之间'}), 400
    
    def generate():
        try:
            # 尝试从数据库获取缓存图谱
            cached_graph = DatabaseManager.get_best_graph(topic, count)
            if cached_graph:
                yield "data: " + json.dumps({
                    'status': 'complete',
                    'progress': 100,
                    'message': '正在获取知识图谱...',
                    'data': {
                        'graph_id': cached_graph['id'],
                        'concepts': cached_graph['concepts'],
                        'relationships': cached_graph['relationships'],
                        'network_data': create_network_data(
                            cached_graph['concepts'],
                            cached_graph['relationships']
                        )
                    }
                }) + '\n\n'
                return

            # 第一阶段：流式生成概念
            yield "data: " + json.dumps({
                'status': 'generating_concepts',
                'progress': 20,
                'message': '正在初始化...\n接下来可能需要几分钟'
            }) + '\n\n'
            
            accumulated_text = ""
            generated_concepts = []
            key_pattern = re.compile(r'"([^"]+)"\s*:')
            last_update_time = 0  # 添加时间追踪
            dot_phase = 0  # 初始化省略号计数器
            
            # 调用生成概念函数，启用流式输出
            for chunk in generate_concepts(topic, count, stream=True):
                accumulated_text += chunk
                current_time = time.time()
                # 每0.3秒更新一次进度（包括省略号动画）
                if current_time - last_update_time >= 0.3:
                    keys = key_pattern.findall(accumulated_text)
                    for key in keys:
                        if "✅" + key not in generated_concepts:
                            generated_concepts.append("✅" + key)
                    progress_value = 30 + (len(generated_concepts) / count) * 40
                    progress_value = min(progress_value, 70)
                    # 根据计数器计算省略号数量（循环显示1到3个点）
                    dots = '.' * ((dot_phase % 3) + 1)
                    dot_phase += 1
                    display_message = "正在生成概念:\n" + "\n".join(generated_concepts) + dots
                    yield "data: " + json.dumps({
                        'status': 'generating_concepts_partial',
                        'progress': progress_value,
                        'message': display_message
                    }) + '\n\n'
                    last_update_time = current_time
            
            # 第二阶段：生成概念关系
            yield "data: " + json.dumps({
                'status': 'generating_relationships',
                'progress': 70,
                'message': '正在分析概念关系...\n概念太多的话可能需时几分钟'
            }) + '\n\n'
            
            # 解析完整的概念 JSON 文本（假设流式返回内容构成完整 JSON）
            concepts = parse_json_response(accumulated_text, error_context=f"处理主题 '{topic}' 的概念生成结果时")
            relationships = generate_relationships(concepts)
            network_data = create_network_data(concepts, relationships)
            
            # 保存生成的图谱
            graph_id = DatabaseManager.save_knowledge_graph(
                topic=topic,
                concept_count=count,
                concepts=concepts,
                relationships=relationships
            )
    
            yield "data: " + json.dumps({
                'status': 'complete',
                'progress': 100,
                'message': '生成完成！',
                'data': {
                    'graph_id': graph_id,
                    'concepts': concepts,
                    'relationships': relationships,
                    'network_data': network_data
                }
            }) + "\n\n"
    
        except Exception as e:
            yield "data: " + json.dumps({
                'status': 'error',
                'message': str(e)
            }) + '\n\n'
    
    return Response(stream_with_context(generate()), mimetype='text/event-stream')

@app.route('/feedback', methods=['POST'])
def feedback():
    logging.info("收到 feedback 请求")
    logging.debug(f"请求数据: {request.json}")
    
    try:
        graph_id = request.json.get('graph_id')
        is_like = request.json.get('is_like')
        user_id = request.cookies.get('user_id')
        topic = request.json.get('topic')
        count = request.json.get('count')
        
        # 参数校验
        if graph_id is None:
            return jsonify({'error': '缺少 graph_id 参数'}), 400
        if is_like is None:
            return jsonify({'error': '缺少 is_like 参数'}), 400
        if not user_id:
            return jsonify({'error': '用户 ID 无效'}), 400
        if not topic:
            return jsonify({'error': '缺少主题参数'}), 400
        if not count or not isinstance(count, int) or not 5 <= count <= 20:
            return jsonify({'error': '概念数量无效'}), 400
        
        result = DatabaseManager.update_feedback(graph_id, is_like)
        
        # 判断是否为【新增概念】场景，并读取 force_regenerate 标记
        is_new_concept_flag = request.json.get('is_new_concept')
        force_regenerate = False
        if is_new_concept_flag:
            force_regenerate = request.json.get('added_concept_data', {}).get('regenerate', False)
        
        # 用户反馈"不满意"
        if not is_like:
            # 如果非【新增概念】或者没有强制重生标记，则执行缓存逻辑
            if not (is_new_concept_flag and force_regenerate):
                DatabaseManager.record_user_view(user_id, graph_id)
                viewed_count = DatabaseManager.get_viewed_count(topic, count, user_id)
                print(f"Viewed count: {viewed_count}")  # 添加调试日志
                
                if viewed_count < 3:
                    top_graphs = DatabaseManager.get_top_n_graphs(topic, count, user_id)
                    print(f"Found top graphs: {len(top_graphs) if top_graphs else 0}")  # 添加调试日志
                    if top_graphs:
                        next_graph = top_graphs[0]
                        network_data = create_network_data(
                            next_graph['concepts'],
                            next_graph['relationships']
                        )
                        return jsonify({
                            'status': 'complete',
                            'progress': 100,
                            'message': '获取缓存图谱成功',
                            'data': {
                                'graph_id': next_graph['id'],
                                'concepts': next_graph['concepts'],
                                'relationships': next_graph['relationships'],
                                'network_data': network_data
                            }
                        })
            # 进入生成分支
            if request.json.get('is_new_concept'):
                def generate_new():
                    try:
                        yield "data: " + json.dumps({
                            'status': 'initializing',
                            'progress': 10,
                            'message': '正在初始化...\n接下来可能需要几分钟'
                        }) + '\n\n'
                        
                        # 根据请求中是否包含 base_graph_id，选择正确的基础图谱
                        with Session() as session:
                            base_graph_id = request.json.get('added_concept_data', {}).get('base_graph_id')
                            if base_graph_id:
                                graph = session.query(KnowledgeGraph).get(base_graph_id)
                            else:
                                graph = session.query(KnowledgeGraph).get(graph_id)
                            if not graph:
                                yield "data: " + json.dumps({
                                    'status': 'error',
                                    'message': f'图谱ID {graph_id} 不存在'
                                }) + '\n\n'
                                return
                            topic = graph.topic
                            existing_concepts = graph.concepts
                        
                        yield "data: " + json.dumps({
                            'status': 'generating_new_concept',
                            'progress': 30,
                            'message': '正在生成新概念详细描述'
                        }) + '\n\n'
                        
                        new_concept_input = request.json.get('added_concept_data', {}).get('new_concept')
                        if not new_concept_input:
                            yield "data: " + json.dumps({
                                'status': 'error',
                                'message': '缺少新增概念数据'
                            }) + '\n\n'
                            return
                        
                        new_concept_detail = generate_new_concept_detail(new_concept_input)
                        updated_concepts = existing_concepts.copy()
                        updated_concepts.update(new_concept_detail)
                        
                        yield "data: " + json.dumps({
                            'status': 'merging_concepts',
                            'progress': 50,
                            'message': '正在合并概念'
                        }) + '\n\n'
                        
                        yield "data: " + json.dumps({
                            'status': 'generating_relationships',
                            'progress': 70,
                            'message': '正在分析概念关系...\n概念太多的话可能需时几分钟'
                        }) + '\n\n'
                        
                        updated_relationships = generate_relationships(updated_concepts)
                        network_data = create_network_data(updated_concepts, updated_relationships)
                        
                        new_graph_id = DatabaseManager.save_knowledge_graph(
                            topic=topic,
                            concept_count=len(updated_concepts),
                            concepts=updated_concepts,
                            relationships=updated_relationships
                        )
                        
                        DatabaseManager.record_user_view(user_id, new_graph_id)
        
                        yield "data: " + json.dumps({
                            'status': 'complete',
                            'progress': 100,
                            'message': '新增概念成功，图谱已更新',
                            'data': {
                                'graph_id': new_graph_id,
                                'concepts': updated_concepts,
                                'relationships': updated_relationships,
                                'network_data': network_data
                            }
                        }) + "\n\n"
                    
                    except Exception as e:
                        yield "data: " + json.dumps({
                            'status': 'error',
                            'message': str(e)
                        }) + '\n\n'
                
                return Response(stream_with_context(generate_new()), mimetype='text/event-stream')
            else:
                def generate():
                    try:
                        yield "data: " + json.dumps({
                            'status': 'generating_concepts',
                            'progress': 20,
                            'message': '正在初始化...\n接下来可能需要几分钟'
                        }) + '\n\n'
                        
                        accumulated_text = ""
                        generated_concepts = []
                        key_pattern = re.compile(r'"([^"]+)"\s*:')
                        last_update_time = 0
                        dot_phase = 0
                        
                        for chunk in generate_concepts(topic, count, stream=True):
                            accumulated_text += chunk
                            current_time = time.time()
                            if current_time - last_update_time >= 0.3:
                                keys = key_pattern.findall(accumulated_text)
                                for key in keys:
                                    if "✅" + key not in generated_concepts:
                                        generated_concepts.append("✅" + key)
                                progress_value = 30 + (len(generated_concepts) / count) * 40
                                progress_value = min(progress_value, 70)
                                dots = '.' * ((dot_phase % 3) + 1)
                                dot_phase += 1
                                display_message = "正在生成概念:\n" + "\n".join(generated_concepts) + dots
                                yield "data: " + json.dumps({
                                    'status': 'generating_concepts_partial',
                                    'progress': progress_value,
                                    'message': display_message
                                }) + '\n\n'
                                last_update_time = current_time
                        
                        concepts = parse_json_response(
                            text=accumulated_text,
                            error_context=f"处理主题 '{topic}' 的概念生成结果时"
                        )
                        
                        yield "data: " + json.dumps({
                            'status': 'generating_relationships',
                            'progress': 70,
                            'message': '正在分析概念关系...\n概念太多的话可能需时几分钟'
                        }) + '\n\n'
                        
                        relationships = generate_relationships(concepts)
                        network_data = create_network_data(concepts, relationships)
                        
                        new_graph_id = DatabaseManager.save_knowledge_graph(
                            topic=topic,
                            concept_count=count,
                            concepts=concepts,
                            relationships=relationships
                        )
                        
                        DatabaseManager.record_user_view(user_id, new_graph_id)
                        
                        yield "data: " + json.dumps({
                            'status': 'complete',
                            'progress': 100,
                            'message': '生成完成！',
                            'data': {
                                'graph_id': new_graph_id,
                                'concepts': concepts,
                                'relationships': relationships,
                                'network_data': network_data
                            }
                        }) + "\n\n"
                    
                    except Exception as e:
                        yield "data: " + json.dumps({
                            'status': 'error',
                            'message': str(e)
                        }) + '\n\n'
                
                return Response(stream_with_context(generate()), mimetype='text/event-stream')
        return jsonify(result)
    except Exception as e:
        logging.error(f"处理 feedback 时出错: {str(e)}", exc_info=True)
        # 确保错误响应也是 SSE 格式
        def generate_error():
            yield "data: " + json.dumps({
                'status': 'error',
                'message': str(e)
            }) + '\n\n'
        return Response(generate_error(), mimetype='text/event-stream')

@app.route('/default_graph')
def get_default_graph():
    try:
        graph = DatabaseManager.get_default_graph()
        if graph:
            # 需要使用 create_network_data 函数来正确创建网络数据
            network_data = create_network_data(graph["concepts"], graph["relationships"])
            return jsonify({
                "data": {
                    "graph_id": graph["id"],
                    "network_data": network_data  # 不是直接使用 concepts 和 relationships
                }
            })
        return jsonify({"error": "没有找到默认图谱"})
    except Exception as e:
        print(f"加载默认图谱时出错: {str(e)}")  # 添加错误日志
        return jsonify({"error": str(e)})

@app.route('/add_concept', methods=['POST'])
def add_concept():
    try:
        graph_id = request.json.get('graph_id')
        new_concept_input = request.json.get('new_concept')
        if not graph_id or not new_concept_input:
            return jsonify({'error': '缺少必要参数'}), 400

        def generate():
            try:
                # 获取现有图谱记录
                with Session() as session:
                    graph = session.query(KnowledgeGraph).get(graph_id)
                    if not graph:
                        yield "data: " + json.dumps({
                            'status': 'error',
                            'message': f'图谱ID {graph_id} 不存在'
                        }) + '\n\n'
                        return
                    topic = graph.topic
                    existing_concepts = graph.concepts

                # 第一阶段：初始化
                yield "data: " + json.dumps({
                    'status': 'initializing',
                    'progress': 10,
                    'message': '正在初始化...\n接下来可能需要几分钟'
                }) + '\n\n'
                
                # 第二阶段：生成新概念描述
                yield "data: " + json.dumps({
                    'status': 'generating_new_concept',
                    'progress': 30,
                    'message': '正在生成新概念详细描述'
                }) + '\n\n'
                new_concept_detail = generate_new_concept_detail(new_concept_input)
    
                # 第三阶段：合并概念
                updated_concepts = existing_concepts.copy()
                updated_concepts.update(new_concept_detail)
                yield "data: " + json.dumps({
                    'status': 'merging_concepts',
                    'progress': 50,
                    'message': '正在合并概念'
                }) + '\n\n'
    
                # 第四阶段：生成关联关系
                yield "data: " + json.dumps({
                    'status': 'generating_relationships',
                    'progress': 70,
                    'message': '正在分析概念关系...\n概念太多的话可能需时几分钟'
                }) + '\n\n'
                updated_relationships = generate_relationships(updated_concepts)
    
                # 第五阶段：生成网络数据
                network_data = create_network_data(updated_concepts, updated_relationships)
                yield "data: " + json.dumps({
                    'status': 'finalizing',
                    'progress': 90,
                    'message': '正在生成网络数据'
                }) + '\n\n'
    
                # 第六阶段：保存更新后的图谱
                new_graph_id = DatabaseManager.save_knowledge_graph(
                    topic=topic,
                    concept_count=len(updated_concepts),
                    concepts=updated_concepts,
                    relationships=updated_relationships
                )
    
                yield "data: " + json.dumps({
                    'status': 'complete',
                    'progress': 100,
                    'message': '新增概念成功，图谱已更新',
                    'data': {
                        'graph_id': new_graph_id,
                        'concepts': updated_concepts,
                        'relationships': updated_relationships,
                        'network_data': network_data
                    }
                }) + "\n\n"
    
            except Exception as e:
                yield "data: " + json.dumps({
                    'status': 'error',
                    'message': str(e)
                }) + '\n\n'
    
        return Response(stream_with_context(generate()), mimetype='text/event-stream')
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/search_graph', methods=['POST'])
def search_graph():
    try:
        graph_id = request.json.get('graph_id')
        if not graph_id:
            return jsonify({'error': '缺少图谱编号参数'}), 400
        try:
            graph_id = int(graph_id)
        except ValueError:
            return jsonify({'error': '图谱编号必须为整数'}), 400

        with Session() as session:
            graph = session.query(KnowledgeGraph).get(graph_id)
            if not graph:
                return jsonify({'error': f'未找到图谱，图谱编号: {graph_id}'}), 404
            network_data = create_network_data(graph.concepts, graph.relationships)
            return jsonify({
                "data": {
                    "graph_id": graph.id,
                    "topic": graph.topic,
                    "concept_count": graph.concept_count,
                    "concepts": graph.concepts,
                    "relationships": graph.relationships,
                    "network_data": network_data
                }
            })
    except Exception as e:
        print(f"搜索图谱时出错: {str(e)}")
        return jsonify({"error": str(e)}), 500

@app.route('/check_filter', methods=['POST'])
def check_filter():
    data = request.json
    topic = data.get('topic', '').lower()
    
    # 读取过滤词列表
    filter_path = os.path.join(app.static_folder, 'filter.txt')
    try:
        with open(filter_path, 'r', encoding='utf-8') as f:
            filter_words = [line.strip().lower() for line in f if line.strip()]
        
        # 检查主题是否包含任何过滤词
        is_filtered = any(word in topic for word in filter_words)
        return jsonify({'filtered': is_filtered})
    except Exception as e:
        print(f"Error checking filters: {e}")
        return jsonify({'filtered': False})

@app.route('/get_graph', methods=['GET'])
def get_graph():
    try:
        # 从 URL 参数中获取 graph_id，并转换成整型
        graph_id = request.args.get('graph_id', type=int)
        if not graph_id:
            return jsonify({"error": "缺少 graph_id 参数"}), 400

        # 查询数据库获取对应的图谱对象，这里假设使用 SQLAlchemy，并且 KnowledgeGraph 模型中包含 topic, concepts, relationships 等字段
        with Session() as session:
            graph = session.query(KnowledgeGraph).get(graph_id)
            if not graph:
                return jsonify({"error": f"图谱ID {graph_id} 不存在"}), 404

            # 如果 concepts 是 JSON 格式字符串，则解析为 dict（否则直接使用）
            try:
                if isinstance(graph.concepts, str):
                    concepts_dict = json.loads(graph.concepts)
                else:
                    concepts_dict = graph.concepts
            except Exception as e:
                return jsonify({"error": f"解析图谱 concepts 错误：{str(e)}"}), 500

            # 生成网络数据，注意这里需要调用已有的函数 create_network_data
            network_data = create_network_data(graph.concepts, graph.relationships)

            result = {
                "data": {
                    "graph_id": graph.id,
                    "topic": graph.topic,
                    "conceptCount": len(concepts_dict),
                    "network_data": network_data
                }
            }
            return jsonify(result)
    except Exception as e:
        return jsonify({"error": str(e)}), 500

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000, debug=False)