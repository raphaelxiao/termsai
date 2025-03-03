from configs import client, model, backup_models
from configs.prompt_configs import CONCEPT_PROMPT_TEMPLATE, RELATIONSHIP_PROMPT_TEMPLATE, NEW_CONCEPT_PROMPT_TEMPLATE, RELATIONSHIP_ORG_PROMPT_TEMPLATE, PREJUDGE_PROMPT_TEMPLATE, ORG_PROMPT_TEMPLATE, NEW_ORG_PROMPT_TEMPLATE
import json
import time
from functools import wraps
from typing import Any, Callable
import re

def retry_on_error(max_retries: int = 3, initial_delay: float = 1, max_delay: float = 8) -> Callable:
    """
    重试装饰器，处理API调用错误
    :param max_retries: 最大重试次数
    :param initial_delay: 初始延迟时间（秒）
    :param max_delay: 最大延迟时间（秒）
    """
    def decorator(func: Callable) -> Callable:
        @wraps(func)
        def wrapper(*args, **kwargs) -> Any:
            delay = initial_delay
            last_exception = None
            
            for attempt in range(max_retries):
                try:
                    return func(*args, **kwargs)
                except Exception as e:
                    last_exception = e
                    if attempt < max_retries - 1:
                        print(f"调用失败 (尝试 {attempt + 1}/{max_retries}): {str(e)}")
                        print(f"等待 {delay} 秒后重试...")
                        time.sleep(delay)
                        delay = min(delay * 2, max_delay)  # 指数退避
                    
            print(f"达到最大重试次数 ({max_retries})，操作失败")
            raise last_exception
            
        return wrapper
    return decorator

def clean_json_text(text: str) -> str:
    """
    清理API返回的JSON文本
    """
    text = text.strip()
    if text.startswith("```json"):
        text = text[7:]
    if text.startswith("```"):
        text = text[3:]
    if text.endswith("```"):
        text = text[:-3]
    return text.strip()

def parse_json_response(text: str, error_context: str) -> dict:
    """
    解析JSON响应，处理可能的错误
    """
    try:
        cleaned_text = clean_json_text(text)
        return json.loads(cleaned_text)
    except json.JSONDecodeError as e:
        print("初次解析失败，尝试修正JSON格式...")
        
        try:
            # 1. 预处理：将多行文本转换为单行
            cleaned_text = re.sub(r'\s+', ' ', cleaned_text).strip()
            
            # 2. 使用非贪婪匹配来提取键值对
            pattern = r'"([^"]+)"\s*:\s*"((?:(?!",\s*")[\s\S])*)"(?=\s*,\s*"|\s*}$)'
            pairs = re.findall(pattern, cleaned_text, re.DOTALL)
            
            if not pairs:
                # 如果上面的模式匹配失败，尝试另一种模式
                pattern = r'"([^"]+?)"\s*:\s*"(.*?)(?:(?=",\s*")|(?="\s*}))"'
                pairs = re.findall(pattern, cleaned_text, re.DOTALL)
            
            if not pairs:
                raise ValueError(f"无法提取键值对，原始文本：{cleaned_text}")
            
            # 3. 处理键值对
            fixed_pairs = []
            for key, value in pairs:
                # 清理和转义
                key = key.strip()
                value = value.strip()
                # 处理值中的引号（保留已转义的引号）
                value = re.sub(r'(?<!\\)"', '\\"', value)
                fixed_pairs.append(f'"{key}": "{value}"')
            
            # 4. 重新组装JSON
            fixed_text = "{" + ", ".join(fixed_pairs) + "}"
            
            # 5. 验证结果
            result = json.loads(fixed_text)
            expected_keys = len(re.findall(r'"[^"]+"\s*:', cleaned_text))
            if len(result) != expected_keys:
                raise ValueError(f"键值对数量不匹配：预期 {expected_keys}，实际 {len(result)}")
            
            return result
            
        except Exception as e:
            raise ValueError(
                f"{error_context} 修正JSON后仍然无法解析:\n"
                f"原始文本: {text}\n"
                f"清理后文本: {cleaned_text if 'cleaned_text' in locals() else '未生成'}\n"
                f"提取到的键值对: {pairs if 'pairs' in locals() else []}\n"
                f"修正后文本: {fixed_text if 'fixed_text' in locals() else '未生成'}\n"
                f"详细错误: {str(e)}"
            )

@retry_on_error(max_retries=3)
def call_llm_api(messages: list, context: str, stream: bool = False):
    """
    调用LLM API的通用函数，支持流式输出，遇到限流时自动切换模型
    :param messages: 消息列表
    :param context: 错误上下文描述
    :param stream: 是否启用流式输出
    :return: 若 stream 为 False，则返回完整响应文本；若为 True，则返回生成器逐块yield内容
    """
    global model  # 添加全局声明以便修改model变量
    
    try:
        ai_client = client(model)
        kwargs = {
            "model": model,
            "messages": messages,
            "temperature": 0.7
        }
        if stream:
            kwargs["stream"] = True
        
        if model in ["deepseek-ai/DeepSeek-V3", "Pro/deepseek-ai/DeepSeek-V3"]:
            response = ai_client.chat.completions.create(**kwargs)
        else:
            if stream:
                response = ai_client.chat.completions.create(**kwargs)
            else:
                kwargs["response_format"] = {"type": "json_object"}
                response = ai_client.chat.completions.create(**kwargs)
        
        if stream:
            def stream_generator():
                for chunk in response:
                    delta = chunk.choices[0].delta
                    # 使用 getattr 获取 content 属性（防止出现 .get 错误）
                    content = getattr(delta, "content", "")
                    yield content
            return stream_generator()
        else:
            print(f"LLM回复: {response.choices[0].message.content}")
            return response.choices[0].message.content
            
    except Exception as e:
        error_str = str(e)
        if "429" in error_str:
            # 定义备用模型列表
            current_model = model
            
            # 选择一个不同于当前模型的备用模型
            for backup_model in backup_models:
                if backup_model != current_model:
                    print(f"遇到限流，切换到备用模型: {backup_model}")
                    model = backup_model
                    # 递归调用自身，使用新模型重试
                    return call_llm_api(messages, context, stream)
                    
        raise Exception(f"{context}失败: {str(e)}")

def check_content_filter(text: str) -> bool:
    """
    检查内容是否包含过滤词
    :param text: 要检查的文本
    :return: 如果包含过滤词返回True，否则返回False
    """
    try:
        with open('static/filter.txt', 'r', encoding='utf-8') as f:
            filter_words = [line.strip().lower() for line in f if line.strip()]
        
        text_lower = text.lower()
        return any(word in text_lower for word in filter_words)
    except Exception as e:
        print(f"Error checking content filters: {e}")
        return False

def pre_judge_person(topic: str) -> bool:
    """
    预判主题是否为人物
    :param topic: 主题
    :return: 如果主题为人物返回True，否则返回False
    """
    messages = [{
        "role": "user",
        "content": PREJUDGE_PROMPT_TEMPLATE.format(topic=topic)
    }]
    response_text = call_llm_api(
        messages,
        context="预判主题是否为人物"
    )
    response_data = parse_json_response(
        response_text,
        error_context="处理预判主题是否为人物结果时"
    )   
    return response_data["result"] == "1"  # 确保返回布尔值

def generate_concepts(topic: str, count: int = 10, is_person: bool = False, stream: bool = False):
    """
    生成概念，可以选择流式输出
    :param topic: 主题
    :param count: 概念数量
    :param is_person: 是否为人物类型，默认为False
    :param stream: 是否流式输出，默认为False
    :return: 若 stream 为 False，则返回概念字典；否则返回生成器，逐块yield生成的文本
    """
    # 预判主题是否为人物 - 移除这里的判断，使用传入的is_person参数
    # is_person = pre_judge_person(topic)
    
    if is_person:
        messages = [{
            "role": "user",
            "content": ORG_PROMPT_TEMPLATE.format(topic=topic, count=count)
        }]
    else:
        messages = [{
            "role": "user",
            "content": CONCEPT_PROMPT_TEMPLATE.format(topic=topic, count=count)
        }]
    
    if stream:
        accumulated_text = ""  # 用于累积文本进行过滤检查
        stream_gen = call_llm_api(messages, f"生成主体 '{topic}' 相关的节点", stream=True)
        for chunk in stream_gen:
            accumulated_text += chunk
            # 检查每个新chunk是否包含过滤词
            if check_content_filter(chunk) or check_content_filter(accumulated_text):
                yield "[[CONTENT_FILTERED]]"
                return
            yield chunk
    else:
        # 非流式模式下，分块接收并检查内容
        accumulated_text = ""
        stream_gen = call_llm_api(messages, f"生成主体 '{topic}' 相关的节点", stream=True)
        for chunk in stream_gen:
            # 检查每个新chunk是否包含过滤词
            if check_content_filter(chunk):
                raise ValueError("抱歉，这不是我擅长的主题，问我点别的吧！")
            accumulated_text += chunk
            # 检查累积的文本是否包含过滤词
            if check_content_filter(accumulated_text):
                raise ValueError("抱歉，这不是我擅长的主题，问我点别的吧！")
        
        # 只有在确认没有过滤词后才解析JSON
        return parse_json_response(
            text=accumulated_text,
            error_context=f"处理主体 '{topic}' 的概念生成结果时"
        )

def generate_relationships(concepts: dict, is_person: bool = False) -> list:
    """
    生成关系
    :param concepts: 概念字典
    :param is_person: 是否为人物类型，默认为False
    :return: 关系列表
    """
    try:
        if is_person:
            messages = [{
                "role": "user",
                "content": RELATIONSHIP_ORG_PROMPT_TEMPLATE.format(
                    concepts_json=json.dumps(concepts, ensure_ascii=False)
                )
            }]
        else:
            messages = [{
                "role": "user",
                "content": RELATIONSHIP_PROMPT_TEMPLATE.format(
                    concepts_json=json.dumps(concepts, ensure_ascii=False)
            )
        }]
        
        response_text = call_llm_api(
            messages=messages,
            context="生成概念关系"
        )
        
        # 打印原始响应，用于调试
        print(f"关系生成原始响应: {response_text}")
        
        # 解析 JSON 响应并提取 relations 数组
        response_data = parse_json_response(
            text=response_text,
            error_context="处理概念关系生成结果时"
        )
        
        # 确保返回的是包含 relations 的字典
        if not isinstance(response_data, dict):
            raise ValueError(f"返回的数据格式错误，应为字典但得到: {type(response_data)}")
            
        if 'relations' not in response_data:
            raise ValueError(f"返回的数据缺少 'relations' 字段: {response_data}")
            
        relations = response_data['relations']
        
        # 验证关系数据的格式
        if not isinstance(relations, list):
            raise ValueError(f"relations 不是列表格式: {relations}")
            
        # 验证每个关系是否是包含三个元素的列表
        for i, relation in enumerate(relations):
            if not isinstance(relation, list) or len(relation) != 3:
                raise ValueError(f"关系 {i} 格式错误: {relation}")
        
        return relations
        
    except Exception as e:
        raise ValueError(f"生成关系时出错: {str(e)}")

def format_label(text: str) -> str:
    """
    格式化标签文本，如果存在括号，则处理括号内的英文部分
    """
    if " (" not in text:
        return text

    # 只拆分一次，避免额外的 " (" 导致多个元素
    chinese, english_with_paren = text.split(" (", 1)
    english = english_with_paren.rstrip(")")

    # 以逗号拆分，若正好拆分为两个部分则进行特殊格式化，否则直接返回换行格式
    parts = english.split(", ")
    if len(parts) == 2:
        full_english, abbr = parts
        return f"{chinese} {abbr}\n{full_english}"
    else:
        # 如果拆分的部分不等于2，则直接返回 "中文\n英文"
        return f"{chinese}\n{english}"

def create_network_data(concepts: dict, relationships: list) -> dict:
    """
    创建网络数据
    """
    # 定义层级颜色（使用 Google Material Design 配色）
    color_scheme = {
        "root": "#4285F4",     # Google Blue - 根节点
        "level1": "#EA4335",   # Google Red - 一级节点
        "level2": "#FBBC05",   # Google Yellow - 二级节点
        "level3": "#34A853",   # Google Green - 三级节点
        "level4": "#673AB7",   # Purple - 四级节点
        "level5": "#FF7043"    # Deep Orange - 五级节点
    }
    
    # 根据关系确定节点层级
    def determine_level(node_id, relationships):
        # 找出所有作为目标的节点（被指向的节点）
        targets = set(rel[1] for rel in relationships)
        # 找出所有作为源的节点（指向其他节点的节点）
        sources = set(rel[0] for rel in relationships)
        
        if node_id not in targets:  # 如果节点没有被指向，则为根节点
            return "root"
        elif node_id not in sources:  # 如果节点不指向其他节点，则为最底层
            return "level5"
        else:
            # 计算入度（被指向次数）和出度（指向其他节点次数）
            in_degree = sum(1 for rel in relationships if rel[1] == node_id)
            out_degree = sum(1 for rel in relationships if rel[0] == node_id)
            
            if in_degree > out_degree:
                return "level4"
            elif in_degree == out_degree:
                return "level3"
            else:
                return "level2"

    nodes = []
    edges = []
    
    # 创建节点
    for concept, description in concepts.items():
        level = determine_level(concept, relationships)
        nodes.append({
            'id': concept,
            'label': format_label(concept),
            'color': {
                'background': color_scheme[level],
                'highlight': {
                    'background': color_scheme[level]
                }
            },
            'explanation': description
        })
    
    # 创建边
    for source, target, relation in relationships:
        edges.append({
            'from': source,
            'to': target,
            'label': relation,
            'smooth': {
                'type': 'curvedCW',
                'roundness': 0.2
            }
        })
    
    # 添加网络配置选项
    options = {
        "nodes": {
            "shape": "dot",
            "size": 25,
            "font": {
                "face": "NotoSansHans-Regular",
                "size": 14,
                "multi": True
            }
        },
        "edges": {
            "font": {
                "face": "NotoSansHans-Regular",
                "size": 12
            },
            "smooth": {
                "type": "curvedCW",
                "roundness": 0.2
            },
            "width": 2
        },
        "physics": {
            "barnesHut": {
                "gravitationalConstant": -30000,
                "springLength": 150,
                "springConstant": 0.04,
                "centralGravity": 0.3,
                "damping": 0.09
            }
        },
        "interaction": {
            "hover": True,
            "zoomView": True
        },
        "layout": {
            "randomSeed": 42
        }
    }
    
    return {
        'nodes': nodes,
        'edges': edges,
        'options': options,
        'color_scheme': color_scheme  # 添加颜色方案以供前端使用
    }

@retry_on_error(max_retries=3)
def generate_new_concept_detail(new_concept_input: str, is_person: bool = False) -> dict:
    """
    根据用户输入的新概念生成详细描述
    要求格式为："概念名称": "概念介绍"
    :param new_concept_input: 用户输入的新概念
    :param is_person: 是否为人物类型
    """
    try:
        if is_person:
            messages = [{
                "role": "user",
                "content": NEW_ORG_PROMPT_TEMPLATE.format(
                    new_concept_input=new_concept_input
                )
            }]
        else:
            messages = [{
                "role": "user",
                "content": NEW_CONCEPT_PROMPT_TEMPLATE.format(
                    new_concept_input=new_concept_input
                )
            }]
        
        response_text = call_llm_api(
            messages,
            context=f"生成新概念 '{new_concept_input}' 的描述",
            stream=False
        )
        result = parse_json_response(
            response_text,
            error_context=f"处理新增概念 '{new_concept_input}' 的生成结果时"
        )
        return result
    except Exception as e:
        raise Exception(f"新增概念 '{new_concept_input}' 生成失败: {str(e)}") 